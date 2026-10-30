// Pure helpers for moments; client-safe (no pg / fs).
import type { Range } from "./snap.ts";
import { sliceWords, speakerShares } from "./transcriptText.ts";
import type { Word } from "./schemas.ts";

/** Index of the smallest parent that fully contains `child`, or null. */
export function insideOf(child: Range, parents: Range[]): number | null {
  let best: number | null = null;
  parents.forEach((p, i) => {
    if (p.startMs <= child.startMs && p.endMs >= child.endMs) {
      if (best === null || p.endMs - p.startMs < parents[best]!.endMs - parents[best]!.startMs) best = i;
    }
  });
  return best;
}

/** Speakers with at least `minShare` of the words spoken in `r`, most talkative first. */
export function speakersIn(words: Word[], r: Range, minShare = 0.1): string[] {
  const inRange = sliceWords(words, r);
  if (inRange.length === 0) return [];
  return Object.entries(speakerShares(inRange))
    .filter(([, share]) => share >= minShare)
    .sort((a, b) => b[1] - a[1])
    .map(([speaker]) => speaker);
}

export const SPEECH_GAP_MS = 2_000;

/** The longest run of consecutive words by one speaker; gaps under 2 s inside the run are tolerated. */
export function longestSpeech(words: Word[]): { speaker: string; startMs: number; endMs: number } | null {
  let best: { speaker: string; startMs: number; endMs: number } | null = null;
  let cur: { speaker: string; startMs: number; endMs: number } | null = null;
  for (const w of words) {
    if (cur && cur.speaker === w.speaker && w.startMs - cur.endMs < SPEECH_GAP_MS) {
      cur.endMs = Math.max(cur.endMs, w.endMs);
    } else {
      cur = { speaker: w.speaker, startMs: w.startMs, endMs: w.endMs };
    }
    if (!best || cur.endMs - cur.startMs > best.endMs - best.startMs) best = { ...cur };
  }
  return best;
}
