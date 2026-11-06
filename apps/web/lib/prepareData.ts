import {
  LANGUAGES, type SelectionStatus, type Clip, type ClipEventKind, type ClipFormat, type MomentChecks, type RenderStatus, type SubtitlePosition, type SubtitleStyle, type Track, type TrackCue,
  type TrackStatus,
} from "@digestor/core";
import { languageName } from "./i18n";

/** A clip whose moment (or any moment merged into it) is no longer approved keeps existing; clips without moments are never labelled. */
export function approvalDismissed(
  clip: { momentId: string | null; mergedMomentIds: string[] },
  selections: Record<string, SelectionStatus>,
): boolean {
  const ids = [clip.momentId, ...clip.mergedMomentIds].filter((id): id is string => id !== null);
  return ids.some((id) => selections[id] !== "approved");
}

/** The credit line a clip starts with: the YouTube channel (or uploader); uploads have none. */
export function defaultCredit(session: { source: string; metadata: Record<string, unknown> }): string {
  if (session.source !== "youtube") return "";
  for (const key of ["channel", "uploader"]) {
    const v = session.metadata[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/**
 * Whether "Undo" has something to revert: the latest change still standing is an edit. Undoing a clip's creation
 * would delete it, so that never counts here. `events` are in order (oldest first).
 */
export function canUndo(events: { kind: ClipEventKind; undoneAt: Date | string | null }[]): boolean {
  const live = events.filter((e) => e.undoneAt === null);
  const last = live[live.length - 1];
  return last !== undefined && last.kind !== "create";
}

export type CheckWarning = { kind: "argument" | "context" | "reportedSpeech" | "interpreter"; detail: string | null };

/** The warnings a clip's checks raise, in display order. */
export function checkWarnings(checks: MomentChecks): CheckWarning[] {
  const out: CheckWarning[] = [];
  if (!checks.argumentComplete) out.push({ kind: "argument", detail: checks.continuesWith });
  if (checks.contextRisk !== null) out.push({ kind: "context", detail: checks.contextRisk });
  if (checks.reportedSpeech) out.push({ kind: "reportedSpeech", detail: null });
  if (checks.interpreter) out.push({ kind: "interpreter", detail: null });
  return out;
}

export type ChecksStatus = "checking" | "failed" | "originalCut" | "checked";

/**
 * What the checks panel shows: "checking" while checks are on their way, "failed" when still none after a minute
 * (R11), "originalCut" when the checks were made for the moment's bounds and the clip was trimmed since (R28).
 */
export function checksStatus(a: { checks: MomentChecks | null; originalCut: boolean; timedOut: boolean }): ChecksStatus {
  if (a.checks !== null) return "checked";
  if (a.originalCut) return "originalCut";
  return a.timedOut ? "failed" : "checking";
}

/** Clips whose moment checks are still polled: none yet, and not timed out (or "Check again" restarted them). */
export function checksToPoll(
  items: { id: string; checks: unknown }[],
  timedOut: boolean,
  retrying: Record<string, boolean>,
): string[] {
  return items.filter((i) => i.checks === null && (!timedOut || retrying[i.id] === true)).map((i) => i.id);
}

/** Languages a clip can get subtitles in: the video's own language first, then the offered list, minus existing tracks. */
export function subtitleLanguages(original: string | null, existing: string[]): { code: string; label: string }[] {
  const all = original
    ? [{ code: original, label: LANGUAGES.find((l) => l.code === original)?.label ?? languageName(original) }, ...LANGUAGES.filter((l) => l.code !== original)]
    : [...LANGUAGES];
  return all.filter((l) => !existing.includes(l.code));
}

/** What Prepare clips needs of a clip, as plain data (same shape from a DB row or from an API response). */
export interface ClipView {
  id: string;
  startMs: number;
  endMs: number;
  format: ClipFormat;
  cropOffset: number;
  subtitleStyle: SubtitleStyle;
  subtitlePosition: SubtitlePosition;
  credit: string | null;
  noCreditNeeded: boolean;
  warningsAck: boolean;
  protectedAck: boolean;
  /** The cut starts or ends inside a sentence (an Alt cut). */
  midSentence: boolean;
  updatedAt: string;
}

type Jsonish<T> = { [K in keyof T]: T[K] extends Date ? Date | string : T[K] extends Date | null ? Date | string | null : T[K] };

export function toClipView(c: Jsonish<Clip> & { midSentence?: boolean }): ClipView {
  return {
    id: c.id,
    startMs: c.startMs,
    endMs: c.endMs,
    format: c.format,
    cropOffset: c.cropOffset,
    subtitleStyle: c.subtitleStyle,
    subtitlePosition: c.subtitlePosition,
    credit: c.credit,
    noCreditNeeded: c.noCreditNeeded,
    warningsAck: c.warningsAck,
    protectedAck: c.protectedAck,
    midSentence: c.midSentence ?? false,
    updatedAt: new Date(c.updatedAt).toISOString(),
  };
}

export interface TrackView {
  id: string;
  language: string;
  status: TrackStatus;
  cues: TrackCue[];
  approved: boolean;
  burnStatus: RenderStatus;
  /** A burned-in version was made at some point (so `stale` means "out of date", not just "requested"). */
  burnBuilt: boolean;
  error: string | null;
}

export function toTrackView(t: Jsonish<Track>): TrackView {
  return {
    id: t.id,
    language: t.language,
    status: t.status,
    cues: t.cues,
    approved: t.approvedAt !== null,
    burnStatus: t.burnStatus,
    burnBuilt: t.burnKey !== null,
    error: t.error,
  };
}
