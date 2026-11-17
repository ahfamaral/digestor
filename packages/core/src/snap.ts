import type { Word } from "./schemas.ts";

export const SENTENCE_END_CHARS = [".", "?", "!", "…", "。", "？", "！"] as const;

const CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "}", "»", "」", "』", "）"]);

/** True when the word ends a sentence; trailing closing quotes/brackets are ignored. */
export function endsSentence(text: string): boolean {
  const chars = [...text];
  while (chars.length > 0 && CLOSERS.has(chars[chars.length - 1]!)) chars.pop();
  const last = chars[chars.length - 1];
  return last !== undefined && (SENTENCE_END_CHARS as readonly string[]).includes(last);
}

export type Boundary = { afterWordEndMs: number; beforeWordStartMs: number };
export type Range = { startMs: number; endMs: number };

/** A pause counts as a cut point only when no sentence end (or video edge) lies within this distance of it. */
export const PAUSE_REACH_MS = 10_000;

/**
 * Where a cut may fall: the video edges, every sentence end, and pauses of at least `minPauseMs` inside sentences
 * longer than `pauseReachMs` (speakers pause mid-sentence, so a pause near a sentence end is not a boundary).
 * Nothing lies past `durationMs`: words can run past it (they are clamped to the audio's length, the video's may be
 * shorter), so later boundaries are dropped, a gap crossing it ends at it, and the end edge is a clean gap at it.
 */
export function findBoundaries(words: Word[], durationMs: number, minPauseMs = 300, pauseReachMs = PAUSE_REACH_MS): Boundary[] {
  if (words.length === 0) return [];
  const all: (Boundary & { sentence: boolean })[] = [{ afterWordEndMs: 0, beforeWordStartMs: words[0]!.startMs, sentence: true }];
  for (let i = 0; i < words.length - 1; i++) {
    const cur = words[i]!;
    const next = words[i + 1]!;
    const gap = next.startMs - cur.endMs;
    const sentence = endsSentence(cur.text);
    if (cur.endMs >= durationMs) break;
    if (gap >= 0 && (gap >= minPauseMs || sentence)) {
      all.push({ afterWordEndMs: cur.endMs, beforeWordStartMs: Math.min(next.startMs, durationMs), sentence });
    }
  }
  all.push({ afterWordEndMs: Math.min(words[words.length - 1]!.endMs, durationMs), beforeWordStartMs: durationMs, sentence: true });

  const nearSentence = all.map(() => false);
  let prev = -Infinity;
  for (let i = 0; i < all.length; i++) {
    if (all[i]!.sentence) prev = all[i]!.afterWordEndMs;
    else nearSentence[i] = all[i]!.afterWordEndMs - prev <= pauseReachMs;
  }
  let next = Infinity;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.sentence) next = all[i]!.afterWordEndMs;
    else nearSentence[i] ||= next - all[i]!.afterWordEndMs <= pauseReachMs;
  }
  return all.filter((b, i) => b.sentence || !nearSentence[i]).map(({ afterWordEndMs, beforeWordStartMs }) => ({ afterWordEndMs, beforeWordStartMs }));
}

function nearestIndex(b: Boundary[], from: number, to: number, pick: (x: Boundary) => number, target: number): number {
  let best = from;
  for (let i = from + 1; i <= to; i++) {
    if (Math.abs(pick(b[i]!) - target) < Math.abs(pick(b[best]!) - target)) best = i;
  }
  return best;
}

export function snapRange(b: Boundary[], r: Range, padMs = 150): Range {
  if (b.length < 2) throw new Error("snapRange requires at least 2 boundaries");
  const n = b.length;
  const s = nearestIndex(b, 0, n - 2, (x) => x.beforeWordStartMs, r.startMs);
  const e = Math.max(nearestIndex(b, 1, n - 1, (x) => x.afterWordEndMs, r.endMs), s + 1);
  const sb = b[s]!;
  const eb = b[e]!;
  return {
    startMs: Math.max(sb.afterWordEndMs, sb.beforeWordStartMs - padMs),
    endMs: Math.min(eb.beforeWordStartMs, eb.afterWordEndMs + padMs),
  };
}

/** True when the start or the end lies in no boundary gap (gap ends included): the cut falls while someone is speaking. */
export function cutsMidSentence(b: Boundary[], r: Range): boolean {
  const inGap = (ms: number) => b.some((x) => ms >= x.afterWordEndMs && ms <= x.beforeWordStartMs);
  return !(inGap(r.startMs) && inGap(r.endMs));
}

/** An edge is untouched when the request is the stored value floored to tenths (what `formatTimestamp` sends). */
const untouched = (requested: number, current: number, toleranceMs: number) => {
  const d = current - requested;
  return d >= 0 && d < toleranceMs;
};

/**
 * Snaps only the edges that changed. An untouched edge (the request equals the stored value floored to tenths: times
 * travel as tenths of a second, stored edges are whole ms) is kept verbatim. A single changed edge snaps on its own
 * against the kept one; with both changed, or nothing valid, the whole request goes through `snapRange`.
 */
export function snapEdges(b: Boundary[], current: Range, requested: Range, toleranceMs = 100, padMs = 150): Range {
  const snapped = snapRange(b, requested, padMs);
  const keepStart = untouched(requested.startMs, current.startMs, toleranceMs);
  const keepEnd = untouched(requested.endMs, current.endMs, toleranceMs);
  if (keepStart === keepEnd) {
    const r = { startMs: keepStart ? current.startMs : snapped.startMs, endMs: keepEnd ? current.endMs : snapped.endMs };
    return r.startMs >= r.endMs ? snapped : r;
  }
  let best: number | null = null;
  let bestDist = Infinity;
  if (keepStart) {
    for (let i = 1; i < b.length; i++) {
      const x = b[i]!;
      const pos = Math.min(x.beforeWordStartMs, x.afterWordEndMs + padMs);
      const dist = Math.abs(x.afterWordEndMs - requested.endMs);
      if (pos > current.startMs && dist < bestDist) { best = pos; bestDist = dist; }
    }
    return best === null ? snapped : { startMs: current.startMs, endMs: best };
  }
  for (let i = 0; i < b.length - 1; i++) {
    const x = b[i]!;
    const pos = Math.max(x.afterWordEndMs, x.beforeWordStartMs - padMs);
    const dist = Math.abs(x.beforeWordStartMs - requested.startMs);
    if (pos < current.endMs && dist < bestDist) { best = pos; bestDist = dist; }
  }
  return best === null ? snapped : { startMs: best, endMs: current.endMs };
}

/** Like `snapEdges`, with no snapping: a changed edge is taken as given (the Alt cut). */
export function freeEdges(current: Range, requested: Range, toleranceMs = 100): Range {
  return {
    startMs: untouched(requested.startMs, current.startMs, toleranceMs) ? current.startMs : requested.startMs,
    endMs: untouched(requested.endMs, current.endMs, toleranceMs) ? current.endMs : requested.endMs,
  };
}

export function overlapRatio(a: Range, b: Range): number {
  const inter = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shorter <= 0 ? 0 : inter / shorter;
}
