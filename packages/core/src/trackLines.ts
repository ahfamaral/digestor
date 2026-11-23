// Client-safe: the subtitle editor's line list (times, delete, add) and the repair of impossible word times.
import type { TrackCue } from "./personalTypes.ts";
import type { Word } from "./schemas.ts";

/** The shortest line the editor accepts. */
export const MIN_LINE_MS = 200;
/** The most lines one track can hold. */
export const MAX_TRACK_LINES = 2000;

/** One line as the editor sends it: `from` is the index of the stored line it came from, null for an added line. */
export interface TrackLineInput {
  startMs: number;
  endMs: number;
  text: string;
  from?: number | null;
}

export type TrackLineProblem = "empty" | "short" | "outside" | "overlap";

/**
 * What is wrong with an edited list of lines (clip-relative times, `lengthMs` the clip's length), per line, in order:
 * a line shorter than `MIN_LINE_MS` (or ending before it starts), outside the clip, or starting before the previous
 * one ends. Touching lines are fine. An empty list is `{ i: -1, problem: "empty" }`.
 */
export function checkTrackLines(lines: { startMs: number; endMs: number }[], lengthMs: number): { i: number; problem: TrackLineProblem }[] {
  if (lines.length === 0) return [{ i: -1, problem: "empty" }];
  const out: { i: number; problem: TrackLineProblem }[] = [];
  lines.forEach((l, i) => {
    if (l.endMs - l.startMs < MIN_LINE_MS) out.push({ i, problem: "short" });
    else if (l.startMs < 0 || l.endMs > lengthMs) out.push({ i, problem: "outside" });
    else if (i > 0 && l.startMs < lines[i - 1]!.endMs) out.push({ i, problem: "overlap" });
  });
  return out;
}

/**
 * The stored lines for an edited list: a line from a stored one keeps its original, and its word times only while its
 * start and end are unchanged (new times mean the speech no longer lines up: it shows plain and splits by characters).
 * An added line has no original and is marked `added`. `missing` follows the text.
 */
export function applyTrackLines(stored: TrackCue[], lines: TrackLineInput[]): TrackCue[] {
  return lines.map((l) => {
    const base = l.from === null || l.from === undefined ? undefined : stored[l.from];
    const cue: TrackCue = { startMs: l.startMs, endMs: l.endMs, original: base?.original ?? "", text: l.text, missing: l.text.trim() === "" };
    if (base?.words && base.startMs === l.startMs && base.endMs === l.endMs) cue.words = base.words;
    if (!base || base.added) cue.added = true;
    return cue;
  });
}

/** A fingerprint of a track's lines (times, original, text; not word times), so a save can tell they changed meanwhile. */
export function trackLinesVersion(cues: { startMs: number; endMs: number; original: string; text: string }[]): string {
  let h = 0x811c9dc5;
  for (const c of cues) {
    const s = `${c.startMs}|${c.endMs}|${c.original}|${c.text}\n`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `${cues.length}-${h.toString(16)}`;
}

const chars = (w: Word) => Math.max([...w.text].length, 1);
/** Faster than anyone speaks: under 25 ms a character (short words count as 3). */
const crushed = (w: Word) => w.endMs - w.startMs < 25 * Math.max(chars(w), 3);
/** Held far longer than said: at least 0.6 s and 200 ms a character. */
const stretched = (w: Word) => w.endMs - w.startMs >= 600 && w.endMs - w.startMs >= 200 * chars(w);
const NEIGHBOURS = 3;
const MIN_RUN = 3;

/**
 * Repairs word times a transcript got wrong under noise (a crowd chant): a run of at least 3 crushed words next to a
 * stretched word within 3 words (before or after) can't be real speech, so the words from the stretched one through
 * the run share their whole span by character count (+1 each), back to back. A crushed run with no stretched
 * neighbour is left alone (there is no time to borrow). Order, text and the other fields never change.
 */
export function repairWordTimes(words: Word[]): Word[] {
  const out = words.map((w) => ({ ...w }));
  let i = 0;
  while (i < out.length) {
    if (!crushed(out[i]!)) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < out.length && crushed(out[end + 1]!)) end++;
    if (end - i + 1 < MIN_RUN) {
      i = end + 1;
      continue;
    }
    let from = i;
    for (let j = Math.max(0, i - NEIGHBOURS); j < i; j++) {
      if (stretched(out[j]!)) {
        from = j;
        break;
      }
    }
    let to = end;
    for (let j = Math.min(out.length - 1, end + NEIGHBOURS); j > end; j--) {
      if (stretched(out[j]!)) {
        to = j;
        break;
      }
    }
    if (from !== i || to !== end) spread(out, from, to);
    i = to + 1;
  }
  return out;
}

function spread(words: Word[], from: number, to: number): void {
  const start = words[from]!.startMs;
  const span = words[to]!.endMs - start;
  const weights = words.slice(from, to + 1).map((w) => chars(w) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let k = from; k <= to; k++) {
    const begin = start + Math.round((acc / total) * span);
    acc += weights[k - from]!;
    words[k]!.startMs = begin;
    words[k]!.endMs = start + Math.round((acc / total) * span);
  }
}
