import type { Resolution } from "./attribution.ts";
import type { Moment, MomentChecks } from "./analysisTypes.ts";
import type { Clip, Track } from "./personalTypes.ts";
import type { ProfileId } from "./profiles.ts";

export type ChecklistId = "argument" | "context" | "flags" | "subtitles" | "credit" | "protected" | "speaker";

type ClipBounds = Pick<Clip, "startMs" | "endMs">;
type MomentForChecks = Pick<Moment, "startMs" | "endMs" | "checks">;

/**
 * The moment's checks when they describe this clip, i.e. while the clip still has the moment's exact bounds (R28).
 * `originalCut` is true when checks exist but were made for the moment's cut, which the clip no longer has.
 */
export function checksForClip(clip: ClipBounds, moment: MomentForChecks | null): { checks: MomentChecks | null; originalCut: boolean } {
  if (!moment?.checks) return { checks: null, originalCut: false };
  if (moment.startMs !== clip.startMs || moment.endMs !== clip.endMs) return { checks: null, originalCut: true };
  return { checks: moment.checks, originalCut: false };
}

export type ClipSpeaker = { speakerId: string; resolution: Resolution; ms: number };

/** The voices of a clip that still need a confirmed name (or "no name"). */
export function unconfirmedSpeakers<T extends Pick<ClipSpeaker, "resolution">>(speakers: T[]): T[] {
  return speakers.filter(({ resolution: r }) => !(r.kind === "anonymous" || (r.kind === "named" && r.confirmed)));
}

/**
 * What must hold before a clip is exported. `argument`, `context` and `flags` are ok when the moment's checks say
 * so, or when the user acknowledged the warnings; with no checks for this cut (they couldn't run, or the clip was
 * trimmed away from its moment's bounds) only the acknowledgement lets the clip through. `subtitles`: no track is
 * outdated, and every track with a burn request is approved. `speaker`: every voice in the clip (`speakersInRange`)
 * is a confirmed name or marked "no name"; it ignores `warningsAck`. `protected` exists for the trial profile only.
 */
export function exportChecklist(a: {
  clip: Pick<Clip, "credit" | "noCreditNeeded" | "warningsAck" | "protectedAck" | "startMs" | "endMs">;
  moment: MomentForChecks | null;
  tracks: Pick<Track, "burnStatus" | "approvedAt" | "status">[];
  profile: ProfileId;
  speakers: ClipSpeaker[];
}): { id: ChecklistId; ok: boolean }[] {
  const { clip, tracks, profile } = a;
  const { checks } = checksForClip(clip, a.moment);
  const ack = clip.warningsAck;
  const items: { id: ChecklistId; ok: boolean }[] = [
    { id: "argument", ok: ack || (checks !== null && checks.argumentComplete) },
    { id: "context", ok: ack || (checks !== null && checks.contextRisk === null) },
    { id: "flags", ok: ack || (checks !== null && !checks.reportedSpeech && !checks.interpreter) },
    {
      id: "subtitles",
      ok: tracks.every(
        (t) => t.status !== "outdated" && (t.burnStatus === "none" || (t.approvedAt !== null && t.status === "ready")),
      ),
    },
    { id: "credit", ok: clip.noCreditNeeded || (clip.credit ?? "").trim() !== "" },
    { id: "speaker", ok: unconfirmedSpeakers(a.speakers).length === 0 },
  ];
  if (profile === "trial") items.push({ id: "protected", ok: clip.protectedAck });
  return items;
}
