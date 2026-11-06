import {
  LANGUAGES, type SelectionStatus, type Clip, type ClipEventKind, type ClipFormat, type MomentChecks, type RenderStatus, type SubtitlePosition, type SubtitleStyle, type Track, type TrackCue,
  type TrackStatus, type Range,
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

/**
 * Where Prepare offers a merge, for clips sorted by start: gap index `i` (the button sits between clip `i` and `i + 1`)
 * → the index of the earlier clip that clip `i + 1` merges with. That earlier clip is the one reaching furthest so far
 * (a clip nested inside it never hides the pair). A merge is offered only when the two overlap partly or touch: never
 * across a gap, and never when one clip lies inside the other (same start, or ending no later), which adds nothing.
 */
export function mergePairs(clips: { startMs: number; endMs: number }[]): Map<number, number> {
  const out = new Map<number, number>();
  let reach = 0;
  for (let j = 1; j < clips.length; j++) {
    const r = clips[reach]!;
    const c = clips[j]!;
    if (c.startMs > r.startMs && c.startMs <= r.endMs && c.endMs > r.endMs) out.set(j - 1, reach);
    if (c.endMs > r.endMs) reach = j;
  }
  return out;
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

/** What Prepare's Undo would revert; a merge also says the range the clip goes back to. */
export type UndoStep = { kind: "bounds" | "format" | "style" } | { kind: "merge"; range: Range };

/**
 * The change "Undo" would revert: the latest one still standing. Undoing a clip's creation would delete it, so that
 * never counts here (null: nothing to undo). `events` are in order (oldest first).
 */
export function undoStep(events: { kind: ClipEventKind; undoneAt: Date | string | null; before?: unknown }[]): UndoStep | null {
  const last = events.filter((e) => e.undoneAt === null).at(-1);
  if (!last) return null;
  switch (last.kind) {
    case "bounds":
    case "format":
    case "style":
      return { kind: last.kind };
    case "merge": {
      const b = last.before as { startMs: number; endMs: number };
      return { kind: "merge", range: { startMs: b.startMs, endMs: b.endMs } };
    }
    default:
      return null;
  }
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

/** A setting the "For all clips" strip can set. */
export type SharedKey = "credit" | "format";

type SharedClip = { id: string; credit: string | null; format: ClipFormat; noCreditNeeded: boolean; frozen?: boolean };

/** A clip's value for a shared setting; a clip marked "No credit needed" has no credit value (it is never touched). */
function valueOf(c: SharedClip, key: SharedKey): string | null {
  if (key === "format") return c.format;
  return c.noCreditNeeded ? null : (c.credit ?? "").trim();
}

/**
 * The value most clips share for a setting (ties go to the earliest clip's, `clips` being in Prepare order), and the
 * ids of the clips that differ from it. `value` is null only when there are no clips.
 */
export function sharedValue(clips: SharedClip[], key: SharedKey): { value: string | null; differs: string[] } {
  const counts = new Map<string, number>();
  for (const c of clips) {
    const v = valueOf(c, key);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let value: string | null = null;
  let best = 0;
  for (const c of clips) {
    const v = valueOf(c, key);
    const n = v === null ? 0 : (counts.get(v) ?? 0);
    if (n > best) {
      best = n;
      value = v;
    }
  }
  return { value, differs: clips.filter((c) => valueOf(c, key) !== value).map((c) => c.id) };
}

/** The clips a change for all would touch: still on `shared` (the value before the change), not frozen, and not already on `next`. */
export function applyToAll(clips: SharedClip[], key: SharedKey, shared: string | null, next?: string): string[] {
  return clips.filter((c) => !c.frozen && shared !== null && valueOf(c, key) === shared && valueOf(c, key) !== next).map((c) => c.id);
}

/** Adding a subtitle language for all clips: only the clips without it (never frozen ones). Removing stays per clip. */
export function languageTargets(clips: { id: string; languages: string[]; frozen?: boolean }[], code: string): string[] {
  return clips.filter((c) => !c.frozen && !c.languages.includes(code)).map((c) => c.id);
}
