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
