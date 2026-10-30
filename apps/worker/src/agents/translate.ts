import { z } from "zod";
import { LANGUAGES } from "@digestor/core";
import type { StructuredLLM } from "../llm/structured.js";

export const BATCH_SIZE = 80;

/** Lenient on purpose: the model may skip, repeat or invent numbers; normalizeTranslation maps by index. */
export const TranslationOutput = z.object({
  lines: z
    .array(z.object({ n: z.number(), text: z.string() }))
    .describe("One entry per input line: its number and its translation"),
});
export type TranslationOutput = z.infer<typeof TranslationOutput>;

export type TranslatedLine = { text: string; missing: boolean };

/** Maps output lines to the originals by number (1-based). Gaps stay empty and flagged; extra numbers are ignored. */
export function normalizeTranslation(original: string[], out: TranslationOutput): TranslatedLine[] {
  const byN = new Map<number, string>();
  for (const l of out.lines) if (Number.isInteger(l.n) && l.n >= 1 && l.n <= original.length && !byN.has(l.n)) byN.set(l.n, l.text.trim());
  return original.map((_, i) => {
    const text = byN.get(i + 1);
    return text ? { text, missing: false } : { text: "", missing: true };
  });
}

const label = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code;

/** Translates subtitle lines in batches. Errors (including MissingApiKeyError) propagate to the job handler. */
export async function translateCues(
  llm: StructuredLLM,
  a: { from: string; to: string; lines: string[] },
): Promise<TranslatedLine[]> {
  const system = [
    `You translate subtitle lines from ${label(a.from)} (${a.from}) to ${label(a.to)} (${a.to}).`,
    "Keep the meaning, tone and every name exactly; do not explain, add, merge or split lines.",
    "Return exactly one entry per numbered input line, with the same number. The line count must not change.",
  ].join("\n");
  const out: TranslatedLine[] = [];
  for (let i = 0; i < a.lines.length; i += BATCH_SIZE) {
    const batch = a.lines.slice(i, i + BATCH_SIZE);
    const user = batch.map((l, j) => `${j + 1}. ${l.replace(/\s*\n\s*/g, " ")}`).join("\n");
    const raw = await llm.generate({ schema: TranslationOutput, name: "translate_cues", system, user, model: "fast" });
    out.push(...normalizeTranslation(batch, raw));
  }
  return out;
}
