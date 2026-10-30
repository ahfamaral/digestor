// Client-safe row shapes of the official analysis (Ruling R3). `db/analysis.ts` returns these; web client code
// imports them from `@digestor/core` without pulling pg.
import { z } from "zod";
import type { Granularity, HighlightTypeId } from "./profiles.ts";

export const MomentChecksSchema = z.object({
  argumentComplete: z.boolean(),
  continuesWith: z.string().nullable(),
  unansweredQuestion: z.boolean(),
  contextRisk: z.string().nullable(),
  reportedSpeech: z.boolean(),
  interpreter: z.boolean(),
});
export type MomentChecks = z.infer<typeof MomentChecksSchema>;

export const BriefingSentenceSchema = z.object({ text: z.string(), momentIds: z.array(z.string()) });
export type BriefingSentence = z.infer<typeof BriefingSentenceSchema>;

export const BriefingContentSchema = z.object({
  lead: z.array(BriefingSentenceSchema),
  sections: z.array(
    z.object({
      topicId: z.string(),
      summary: z.array(BriefingSentenceSchema),
      keyQuote: z.object({ momentId: z.string(), text: z.string() }).nullable(),
    }),
  ),
});
export type BriefingContent = z.infer<typeof BriefingContentSchema>;

/** A briefing translated for reading: quotes keep the verbatim `original` next to their `translation`. */
export interface TranslatedBriefingContent {
  lead: BriefingSentence[];
  sections: {
    topicId: string;
    summary: BriefingSentence[];
    keyQuote: { momentId: string; original: string; translation: string } | null;
  }[];
}

export type AnalysisStatus = "running" | "complete" | "failed";
export type MomentOrigin = "ai" | "counted" | "ask" | "user";
export type HighlightMethod = "ai" | "counted";

export interface AnalysisVersion {
  id: string;
  sessionId: string;
  version: number;
  status: AnalysisStatus;
  profile: string;
  pipelineVersion: string;
  models: Record<string, string>;
  promptVersions: Record<string, string>;
  reason: string;
  isCurrent: boolean;
  createdAt: Date;
}

export interface Topic {
  id: string;
  analysisId: string;
  idx: number;
  startMs: number;
  endMs: number;
  title: string;
  summary: string;
}

export interface Moment {
  id: string;
  analysisId: string;
  topicId: string | null;
  granularity: Granularity;
  startMs: number;
  endMs: number;
  title: string;
  why: string;
  relevance: number;
  speakers: string[];
  insideMomentId: string | null;
  evidence: string[];
  checks: MomentChecks | null;
  thumbKey: string | null;
  /** null = official (part of the analysis); otherwise a personal moment. */
  ownerId: string | null;
  origin: MomentOrigin;
}

export interface MomentHighlight {
  type: HighlightTypeId;
  method: HighlightMethod;
  value: number | null;
}

export type MomentWithHighlights = Moment & { highlights: MomentHighlight[] };

export interface AnalysisBundle {
  version: Pick<AnalysisVersion, "id" | "version" | "reason" | "status" | "createdAt" | "profile">;
  topics: Topic[];
  moments: MomentWithHighlights[];
  briefing: BriefingContent | null;
}
