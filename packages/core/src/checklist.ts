import type { MomentChecks } from "./analysisTypes.ts";
import type { Clip, Track } from "./personalTypes.ts";
import type { ProfileId } from "./profiles.ts";

export type ChecklistId = "argument" | "context" | "flags" | "subtitles" | "credit" | "protected";

/**
 * What must hold before a clip is exported. `argument`, `context` and `flags` are ok when the moment's checks say
 * so, or when the user acknowledged the warnings; with no checks (they couldn't run) only the acknowledgement
 * lets the clip through. `subtitles`: every track with a burn request is approved. `protected` exists for the
 * trial profile only.
 */
export function exportChecklist(a: {
  clip: Pick<Clip, "credit" | "noCreditNeeded" | "warningsAck" | "protectedAck">;
  checks: MomentChecks | null;
  tracks: Pick<Track, "burnStatus" | "approvedAt" | "status">[];
  profile: ProfileId;
}): { id: ChecklistId; ok: boolean }[] {
  const { clip, checks, tracks, profile } = a;
  const ack = clip.warningsAck;
  const items: { id: ChecklistId; ok: boolean }[] = [
    { id: "argument", ok: ack || (checks !== null && checks.argumentComplete) },
    { id: "context", ok: ack || (checks !== null && checks.contextRisk === null) },
    { id: "flags", ok: ack || (checks !== null && !checks.reportedSpeech && !checks.interpreter) },
    { id: "subtitles", ok: tracks.every((t) => t.burnStatus === "none" || (t.approvedAt !== null && t.status === "ready")) },
    { id: "credit", ok: clip.noCreditNeeded || (clip.credit ?? "").trim() !== "" },
  ];
  if (profile === "trial") items.push({ id: "protected", ok: clip.protectedAck });
  return items;
}
