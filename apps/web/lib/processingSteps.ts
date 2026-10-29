/** Stage names as stored in sessions.stage (mirrors core's Stage; kept client-safe). */
export type StageName =
  | "uploaded" | "downloading" | "preparing" | "transcribing" | "understanding" | "awaiting_context"
  | "finding_clips" | "awaiting_review" | "rendering" | "done" | "failed";

export type StepState = "done" | "running" | "waiting";
export interface Step {
  key: string;
  label: string;
  state: StepState;
}

const PIPELINE: { stage: StageName; label: string }[] = [
  { stage: "downloading", label: "Downloading from YouTube" },
  { stage: "preparing", label: "Preparing video" },
  { stage: "transcribing", label: "Transcribing" },
  { stage: "understanding", label: "Understanding context" },
  { stage: "finding_clips", label: "Finding moments" },
];

/** Stepper rows for a stage: earlier steps done, the matching one running, later ones waiting. */
export function buildSteps(stage: StageName, source: "upload" | "youtube"): Step[] {
  if (stage === "rendering") return [{ key: "rendering", label: "Rendering clips", state: "running" }];
  const steps = PIPELINE.filter((s) => source === "youtube" || s.stage !== "downloading");
  const at = steps.findIndex((s) => s.stage === stage); // -1 for `uploaded`: nothing started yet
  return steps.map((s, i) => ({
    key: s.stage,
    label: s.label,
    state: at === -1 ? "waiting" : i < at ? "done" : i === at ? "running" : "waiting",
  }));
}
