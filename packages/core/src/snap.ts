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
 */
export function findBoundaries(words: Word[], durationMs: number, minPauseMs = 300, pauseReachMs = PAUSE_REACH_MS): Boundary[] {
  if (words.length === 0) return [];
  const all: (Boundary & { sentence: boolean })[] = [{ afterWordEndMs: 0, beforeWordStartMs: words[0]!.startMs, sentence: true }];
  for (let i = 0; i < words.length - 1; i++) {
    const cur = words[i]!;
    const next = words[i + 1]!;
    const gap = next.startMs - cur.endMs;
    const sentence = endsSentence(cur.text);
    if (gap >= 0 && (gap >= minPauseMs || sentence)) {
      all.push({ afterWordEndMs: cur.endMs, beforeWordStartMs: next.startMs, sentence });
    }
  }
  all.push({ afterWordEndMs: words[words.length - 1]!.endMs, beforeWordStartMs: durationMs, sentence: true });

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

/**
 * Snaps only the edges that changed. An edge within `toleranceMs` of its current value (times travel as tenths of a
 * second, stored edges are whole ms) is kept verbatim. If the result is empty, the whole request is snapped instead.
 */
export function snapEdges(b: Boundary[], current: Range, requested: Range, toleranceMs = 100): Range {
  const snapped = snapRange(b, requested);
  const r = {
    startMs: Math.abs(requested.startMs - current.startMs) <= toleranceMs ? current.startMs : snapped.startMs,
    endMs: Math.abs(requested.endMs - current.endMs) <= toleranceMs ? current.endMs : snapped.endMs,
  };
  return r.startMs >= r.endMs ? snapped : r;
}

/** Like `snapEdges`, with no snapping: a changed edge is taken as given (the Alt cut). */
export function freeEdges(current: Range, requested: Range, toleranceMs = 100): Range {
  return {
    startMs: Math.abs(requested.startMs - current.startMs) <= toleranceMs ? current.startMs : requested.startMs,
    endMs: Math.abs(requested.endMs - current.endMs) <= toleranceMs ? current.endMs : requested.endMs,
  };
}

export function fitChildInParent(child: Range, parent: Range, minMs = 8000): Range | null {
  const startMs = Math.max(child.startMs, parent.startMs);
  const endMs = Math.min(child.endMs, parent.endMs);
  return endMs - startMs < minMs ? null : { startMs, endMs };
}

export function overlapRatio(a: Range, b: Range): number {
  const inter = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shorter <= 0 ? 0 : inter / shorter;
}
