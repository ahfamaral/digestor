import { LANGUAGES, type BriefingContent, type TranslatedBriefingContent } from "@digestor/core";
import type { StructuredLLM } from "../llm/structured.js";
import { BATCH_SIZE, TranslationOutput, normalizeTranslation } from "./translate.js";

const label = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code;

/**
 * Translates every sentence and key quote of a briefing into `to`. Only the text is sent to the model, as numbered
 * lines mapped back by index: ids, timestamps and the original wording never pass through it. A line the model
 * skipped keeps its original sentence (a quote keeps an empty translation, so the UI shows just the original); when
 * the model returned nothing usable at all, this throws so the job retries. Errors (including MissingApiKeyError)
 * propagate to the job handler.
 */
export async function translateBriefing(llm: StructuredLLM, content: BriefingContent, to: string): Promise<TranslatedBriefingContent> {
  const lines: string[] = [
    ...content.lead.map((s) => s.text),
    ...content.sections.flatMap((sec) => [...sec.summary.map((s) => s.text), ...(sec.keyQuote ? [sec.keyQuote.text] : [])]),
  ];
  const system = [
    `You translate a briefing of a long video into ${label(to)} (${to}). Each numbered line is one sentence or one quotation.`,
    "Keep the meaning, tone, numbers and every name exactly; do not explain, add, merge or split lines.",
    "Return exactly one entry per numbered input line, with the same number. The line count must not change.",
  ].join("\n");

  const translated: { text: string; missing: boolean }[] = [];
  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    const user = batch.map((l, j) => `${j + 1}. ${l.replace(/\s*\n\s*/g, " ")}`).join("\n");
    const raw = await llm.generate({ schema: TranslationOutput, name: "translate_briefing", system, user, model: "fast" });
    translated.push(...normalizeTranslation(batch, raw));
  }
  if (lines.length > 0 && translated.every((t) => t.missing)) throw new Error("The model returned no usable translation");

  let next = 0;
  /** The next translated line, in the order the lines were collected; "" when the model skipped it. */
  const take = (): string => translated[next++]!.text;
  return {
    lead: content.lead.map((s) => ({ text: take() || s.text, momentIds: [...s.momentIds] })),
    sections: content.sections.map((sec) => ({
      topicId: sec.topicId,
      summary: sec.summary.map((s) => ({ text: take() || s.text, momentIds: [...s.momentIds] })),
      keyQuote: sec.keyQuote
        ? { momentId: sec.keyQuote.momentId, original: sec.keyQuote.text, translation: take() }
        : null,
    })),
  };
}
