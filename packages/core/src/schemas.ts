import { z } from "zod";
import { ProfileIdSchema } from "./profiles.ts";

export const WordSchema = z.object({
  text: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  speaker: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Word = z.infer<typeof WordSchema>;

export const TranscriptSchema = z.object({
  language: z.string(),
  languageConfidence: z.number(),
  durationMs: z.number().int(),
  words: z.array(WordSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export type ClipStatus = "proposed" | "approved" | "rejected";
export const FactSourceSchema = z.enum(["video", "metadata", "human"]);
export type FactSource = z.infer<typeof FactSourceSchema>;

export const FactSchema = z.object({
  value: z.string().nullable(),
  source: FactSourceSchema.nullable(),
  evidence: z.string().nullable(),
});
export type Fact = z.infer<typeof FactSchema>;

export const ParticipantSchema = z.object({
  speakerId: z.string(),
  name: FactSchema,
  role: FactSchema,
  affiliation: FactSchema,
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  target: z.enum(["date", "profile", "participant", "other"]),
  speakerId: z.string().nullable(),
  question: z.string(),
  why: z.string(),
  sampleStartMs: z.number().nullable(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const ContextCardSchema = z.object({
  language: FactSchema,
  profile: z.object({
    value: ProfileIdSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.string().nullable(),
  }),
  title: FactSchema,
  summary: z.string(),
  setting: FactSchema,
  dateOrYear: FactSchema,
  participants: z.array(ParticipantSchema),
  sufficient: z.boolean(),
  openQuestions: z.array(QuestionSchema).max(3),
});
export type ContextCard = z.infer<typeof ContextCardSchema>;

/** Card fields the journalist changed on the context check (sent with Continue or Skip). */
const CardEditsSchema = z.object({
  title: z.string().optional(),
  setting: z.string().optional(),
  dateOrYear: z.string().optional(),
  profile: ProfileIdSchema.optional(),
  language: z.string().optional(),
  participants: z
    .array(z.object({
      speakerId: z.string(),
      name: z.string().optional(),
      role: z.string().optional(),
      affiliation: z.string().optional(),
    }))
    .optional(),
});

export const ResumePayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("continue"),
    answers: z.array(z.object({ questionId: z.string(), answer: z.string() })),
    cardEdits: CardEditsSchema,
  }),
  // Skip ends the questions but keeps the edits: a profile corrected to trial must not be dropped.
  z.object({ action: z.literal("skip"), cardEdits: CardEditsSchema.optional() }),
]);
export type ResumePayload = z.infer<typeof ResumePayloadSchema>;

/** Pipeline stage as stored in sessions.stage (client-safe: the DB column type lives in db/schema.ts). */
export type Stage =
  | "uploaded"
  | "downloading"
  | "preparing"
  | "transcribing"
  | "naming_speakers"
  | "understanding"
  | "awaiting_context"
  | "indexing"
  | "finding_topics"
  | "finding_moments"
  | "writing_briefing"
  | "preparing_preview"
  | "ready"
  | "failed";

/** The upload pipeline's steps, in order; `pipeline_runs.next_step` holds the one still to run (`done` = finished). */
export const PIPELINE_STEPS = [
  "download", "ingest", "transcribe", "match_record", "understand_context", "ask_context",
  "match_record_late", "name_speakers", "index", "analyze", "done",
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** State of the session's preview copy (`proxy.mp4`); `null` = a session from before the copy got its own job. */
export type ProxyStatus = "pending" | "running" | "done" | "failed";

/** The preview copy exists: `done`, or (a session from before the change) a `proxyKey` with no status. */
export function isProxyReady(s: { proxyStatus: ProxyStatus | null; proxyKey: string | null }): boolean {
  return s.proxyStatus === "done" || (s.proxyStatus === null && s.proxyKey !== null);
}
