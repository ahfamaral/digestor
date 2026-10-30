import { t, type MessageKey } from "@/lib/i18n";

/** Stage names as stored in sessions.stage (mirrors core's Stage; kept client-safe). */
export type StageName =
  | "uploaded" | "downloading" | "preparing" | "transcribing" | "understanding" | "awaiting_context"
  | "indexing" | "finding_topics" | "finding_moments" | "writing_briefing" | "ready" | "failed";

export type StepState = "done" | "running" | "waiting";
export interface Step {
  key: string;
  label: string;
  state: StepState;
}

const PIPELINE: { stage: StageName; label: MessageKey }[] = [
  { stage: "downloading", label: "processing.downloading" },
  { stage: "preparing", label: "processing.preparing" },
  { stage: "transcribing", label: "processing.transcribing" },
  { stage: "understanding", label: "processing.understanding" },
  { stage: "indexing", label: "processing.indexing" },
  { stage: "finding_topics", label: "processing.finding_topics" },
  { stage: "finding_moments", label: "processing.finding_moments" },
  { stage: "writing_briefing", label: "processing.writing_briefing" },
];

/** Stepper rows for a stage: earlier steps done, the matching one running, later ones waiting. */
export function buildSteps(stage: StageName, source: "upload" | "youtube"): Step[] {
  const steps = PIPELINE.filter((s) => source === "youtube" || s.stage !== "downloading");
  const at = steps.findIndex((s) => s.stage === stage); // -1 for `uploaded`: nothing started yet
  return steps.map((s, i) => ({
    key: s.stage,
    label: t(s.label),
    state: at === -1 ? "waiting" : i < at ? "done" : i === at ? "running" : "waiting",
  }));
}
