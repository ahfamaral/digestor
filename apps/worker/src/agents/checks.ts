import { z } from "zod";
import {
  PROFILES,
  formatTimestamp,
  toSentences,
  type ContextCard,
  type MomentChecks,
  type Word,
} from "@digestor/core";
import type { StructuredLLM } from "../llm/structured.js";

export const SENTENCES_BEFORE = 2;
export const SENTENCES_AFTER = 3;

/** Lenient on purpose: booleans and free text only; continuesWith is decided in code. */
export const ChecksOutput = z.object({
  argumentComplete: z.boolean().describe("true when the moment makes its point without needing what follows"),
  continuesWith: z.string().nullish().describe("Ignored: the continuation is taken from the transcript"),
  unansweredQuestion: z.boolean().describe("true when the moment ends on a question that is not answered inside it"),
  contextRisk: z
    .string()
    .nullish()
    .describe("One short sentence if the moment could mislead out of context (sarcasm, hypothetical, quoting someone, missing referent); empty otherwise"),
  reportedSpeech: z.boolean().describe("true when the speaker is quoting or reading someone else's words"),
  interpreter: z.boolean().describe("true when the audio is an interpreter's voice rather than the speaker's"),
});
export type ChecksOutput = z.infer<typeof ChecksOutput>;

/**
 * Checks one moment. Does NOT swallow errors: the pipeline calls this per moment
 * inside its own catch, and MissingApiKeyError must reach it (Ruling R8).
 */
export async function checkMoment(
  llm: StructuredLLM,
  a: { card: ContextCard; moment: { startMs: number; endMs: number; title: string }; words: Word[] },
): Promise<MomentChecks> {
  const all = toSentences(a.words);
  const before = all.filter((s) => s.endMs <= a.moment.startMs).slice(-SENTENCES_BEFORE);
  const inside = all.filter((s) => s.endMs > a.moment.startMs && s.startMs < a.moment.endMs);
  const after = all.filter((s) => s.startMs >= a.moment.endMs).slice(0, SENTENCES_AFTER);
  const line = (s: (typeof all)[number]) => `[${formatTimestamp(s.startMs)}] ${s.speaker}: ${s.text}`;
  const block = (label: string, ss: typeof all) => [label, ...(ss.length ? ss.map(line) : ["(none)"])].join("\n");

  const system = [
    `You check one candidate clip of a long public-interest video (${PROFILES[a.card.profile.value].label}) before it is shown to a reader.`,
    "",
    "Context card:",
    JSON.stringify(a.card, null, 2),
    "",
    "Judge only from the transcript given. Do not guess.",
    "- argumentComplete: false if the moment starts or ends before the speaker finishes the point.",
    "- unansweredQuestion: true if it ends on a question with no answer inside it.",
    "- contextRisk: one short sentence if it could mislead without context; otherwise an empty string.",
    "- reportedSpeech: true if the speaker quotes or reads someone else.",
    "- interpreter: true if an interpreter is speaking.",
  ].join("\n");
  const user = [
    `Moment: ${a.moment.title}`,
    "",
    block("Sentences before the moment:", before),
    "",
    block("The moment:", inside),
    "",
    block("Sentences after the moment:", after),
  ].join("\n");

  const raw = await llm.generate({ schema: ChecksOutput, name: "checks", system, user, model: "fast" });
  const next = after[0];
  return {
    argumentComplete: raw.argumentComplete,
    continuesWith: !raw.argumentComplete && next ? next.text : null,
    unansweredQuestion: raw.unansweredQuestion,
    contextRisk: raw.contextRisk?.trim() ? raw.contextRisk.trim() : null,
    reportedSpeech: raw.reportedSpeech,
    interpreter: raw.interpreter,
  };
}
