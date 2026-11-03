import type { Stage } from "@digestor/core";
import { t, type MessageKey } from "@/lib/i18n";

/** Stage names as stored in sessions.stage. */
export type StageName = Stage;

export type StepState = "done" | "running" | "waiting";
export interface Step {
  key: StepKey;
  label: string;
  state: StepState;
}

export const STEP_KEYS = [
  "intake", "transcribing", "understanding", "naming_speakers", "indexing", "finding_topics", "finding_moments", "writing_briefing", "preparing_preview", "ready",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

const LABEL: Record<StepKey, MessageKey> = {
  intake: "processing.uploading",
  transcribing: "processing.transcribing",
  naming_speakers: "processing.naming_speakers",
  understanding: "processing.understanding",
  indexing: "processing.indexing",
  finding_topics: "processing.finding_topics",
  finding_moments: "processing.finding_moments",
  writing_briefing: "processing.writing_briefing",
  preparing_preview: "processing.preparing_preview",
  ready: "processing.ready",
};

/** Which step each stage belongs to; `failed` belongs to none. A Record over Stage: a new stage breaks the typecheck until it is placed here. */
export const STAGE_STEP: Record<StageName, StepKey | null> = {
  uploaded: "intake",
  downloading: "intake",
  preparing: "intake",
  transcribing: "transcribing",
  naming_speakers: "naming_speakers",
  understanding: "understanding",
  awaiting_context: "understanding",
  indexing: "indexing",
  finding_topics: "finding_topics",
  finding_moments: "finding_moments",
  writing_briefing: "writing_briefing",
  preparing_preview: "preparing_preview",
  ready: "ready",
  failed: null,
};

/** Stepper rows for a stage: earlier steps done, the matching one running, later ones waiting. `ready` completes every step. */
export function buildSteps(stage: StageName, source: "upload" | "youtube"): Step[] {
  const current = STAGE_STEP[stage];
  const at = current === null ? -1 : STEP_KEYS.indexOf(current);
  return STEP_KEYS.map((key, i) => ({
    key,
    label: t(key === "intake" && source === "youtube" ? "processing.downloading" : LABEL[key]),
    state: at === -1 ? "waiting" : stage === "ready" || i < at ? "done" : i === at ? "running" : "waiting",
  }));
}
