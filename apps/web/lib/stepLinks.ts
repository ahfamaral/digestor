import type { Step } from "@/components/AppBar";

/** Where a step of the top bar's stepper leads: Briefing, Prepare and Export once the session is ready; null otherwise. */
export function stepHref(step: Step, session: { id: string; ready: boolean }): string | null {
  if (!session.ready) return null;
  switch (step) {
    case "Briefing":
      return `/s/${session.id}`;
    case "Prepare":
      return `/s/${session.id}/prepare`;
    case "Export":
      return `/s/${session.id}/export`;
    default:
      return null;
  }
}

/** What the page knows about progress, so the stepper only ticks what is really done. */
export interface StepFacts {
  /** The session has at least one confirmed clip. */
  hasClips: boolean;
  /** At least one clip is ready to export and every ready clip is rendered. */
  allReadyRendered: boolean;
}

/** Whether a step earns a ✓ in the stepper. Steps up to Briefing are done once the session is past them. */
export function stepDone(step: Step, facts: StepFacts): boolean {
  switch (step) {
    case "Prepare":
      return facts.hasClips;
    case "Export":
      return facts.hasClips && facts.allReadyRendered;
    default:
      return true;
  }
}
