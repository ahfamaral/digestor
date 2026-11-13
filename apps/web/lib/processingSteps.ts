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
export function buildSteps(stage: StageName, source: "upload" | "youtube", hasVideo = true): Step[] {
  const mapped = STAGE_STEP[stage];
  const current = !hasVideo && mapped === "naming_speakers" ? "understanding" : mapped; // a record may still name an audio session
  // Audio-only sessions skip caption reading, so they have no naming step to show.
  const keys: readonly StepKey[] = hasVideo ? STEP_KEYS : STEP_KEYS.filter((k) => k !== "naming_speakers");
  const at = current === null ? -1 : keys.indexOf(current);
  return keys.map((key, i) => ({
    key,
    label: t(key === "intake" && source === "youtube" ? "processing.downloading" : key === "preparing_preview" && !hasVideo ? "processing.preparing_preview_audio" : LABEL[key]),
    state: at === -1 ? "waiting" : stage === "ready" || i < at ? "done" : i === at ? "running" : "waiting",
  }));
}
