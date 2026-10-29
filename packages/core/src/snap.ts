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

export function findBoundaries(words: Word[], durationMs: number, minPauseMs = 300): Boundary[] {
  if (words.length === 0) return [];
  const out: Boundary[] = [{ afterWordEndMs: 0, beforeWordStartMs: words[0]!.startMs }];
  for (let i = 0; i < words.length - 1; i++) {
    const cur = words[i]!;
    const next = words[i + 1]!;
    const gap = next.startMs - cur.endMs;
    if (gap >= 0 && (gap >= minPauseMs || endsSentence(cur.text))) {
      out.push({ afterWordEndMs: cur.endMs, beforeWordStartMs: next.startMs });
    }
  }
  out.push({ afterWordEndMs: words[words.length - 1]!.endMs, beforeWordStartMs: durationMs });
  return out;
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
