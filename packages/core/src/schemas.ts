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

export const ClipLabelSchema = z.enum(["heated", "key_point", "light"]);
export type ClipLabel = z.infer<typeof ClipLabelSchema>;
export const ClipStatusSchema = z.enum(["proposed", "approved", "neutral", "rejected"]);
export type ClipStatus = z.infer<typeof ClipStatusSchema>;
export const ClipOriginSchema = z.enum(["ai", "user", "copilot"]);
export type ClipOrigin = z.infer<typeof ClipOriginSchema>;
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

const timestamp = z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "expected hh:mm:ss");

// Key order matters: reason comes before label/score so the model reasons first.
export const CandidateSchema = z.object({
  title: z.string(),
  reason: z.string(),
  label: ClipLabelSchema,
  score: z.number().int().min(0).max(100),
  start: timestamp,
  end: timestamp,
  evidence: z.array(z.string()),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const ResumePayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("continue"),
    answers: z.array(z.object({ questionId: z.string(), answer: z.string() })),
    cardEdits: z.object({
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
    }),
  }),
  z.object({ action: z.literal("skip") }),
]);
export type ResumePayload = z.infer<typeof ResumePayloadSchema>;

export type ProposedClip = {
  title: string;
  reason: string;
  label: ClipLabel;
  score: number;
  startMs: number;
  endMs: number;
  children: Omit<ProposedClip, "children">[];
};

/** Pipeline stage as stored in sessions.stage (client-safe: the DB column type lives in db/schema.ts). */
export type Stage =
  | "uploaded"
  | "downloading"
  | "preparing"
  | "transcribing"
  | "understanding"
  | "awaiting_context"
  | "indexing"
  | "finding_topics"
  | "finding_moments"
  | "writing_briefing"
  | "ready"
  | "failed";
