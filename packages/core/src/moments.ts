// Pure helpers for moments; client-safe (no pg / fs).
import type { Range } from "./snap.ts";
import { sliceWords, speakerShares } from "./transcriptText.ts";
import type { Word } from "./schemas.ts";
import { PROFILES, type HighlightTypeId, type ProfileId } from "./profiles.ts";
import type { MomentWithHighlights, Topic } from "./analysisTypes.ts";

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

const GRANULARITY_RANK = { punchline: 0, passage: 1, exchange: 2 } as const;

/** One moment per profile highlight type that has any; best relevance, ties to the shorter granularity, then the earlier start. */
export function topHighlights(
  moments: MomentWithHighlights[],
  profile: ProfileId,
): { type: HighlightTypeId; moment: MomentWithHighlights }[] {
  const out: { type: HighlightTypeId; moment: MomentWithHighlights }[] = [];
  for (const type of PROFILES[profile].highlightTypes) {
    let pool = moments.filter((m) => m.highlights.some((h) => h.type === type));
    if (type === "longest_speech") {
      const counted = pool.filter((m) => m.highlights.some((h) => h.type === type && h.method === "counted"));
      if (counted.length > 0) pool = counted;
    }
    const best = pool.slice().sort(
      (a, b) =>
        b.relevance - a.relevance ||
        GRANULARITY_RANK[a.granularity] - GRANULARITY_RANK[b.granularity] ||
        a.startMs - b.startMs,
    )[0];
    if (best) out.push({ type, moment: best });
  }
  return out;
}

/** The longest topic, or null when there are none. */
export function mostDiscussedTopic(topics: Topic[]): Topic | null {
  let best: Topic | null = null;
  for (const t of topics) if (!best || t.endMs - t.startMs > best.endMs - best.startMs) best = t;
  return best;
}
