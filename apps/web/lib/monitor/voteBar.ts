/**
 * The split of a roll call's recorded votes as a stacked bar (client-safe). Segments in the order the roll-call page
 * lists votes: Sim, Não, Abstenção, Obstrução, Artigo 17, then every other published label together. Each bar is its own
 * whole: the widths show how the votes split, never how many votes there were.
 */
export const VOTE_SEGMENTS = ["Sim", "Não", "Abstenção", "Obstrução", "Artigo 17", "other"] as const;
export type VoteSegmentKey = (typeof VOTE_SEGMENTS)[number];

export type VoteSegment = {
  key: VoteSegmentKey;
  /** The published labels in this segment (one, except for "other"). */
  votes: string[];
  n: number;
  /** Width in tenths of a percent; a bar's segments sum to exactly 1000. */
  tenths: number;
};

/**
 * A vote present in the bar never vanishes: a segment gets at least this many tenths of a percent (1%), taken from the
 * widest segments. The counts beside the bar stay exact.
 */
export const MIN_TENTHS = 10;

/** Segments with at least one vote, in page order; widths by largest remainder so they sum to 100.0%. Empty: []. */
export function voteSegments(counts: { vote: string; n: number }[]): VoteSegment[] {
  const groups = new Map<VoteSegmentKey, { votes: string[]; n: number }>();
  for (const c of counts) {
    if (c.n <= 0) continue;
    const key: VoteSegmentKey = (VOTE_SEGMENTS as readonly string[]).includes(c.vote) && c.vote !== "other" ? (c.vote as VoteSegmentKey) : "other";
    const g = groups.get(key) ?? { votes: [], n: 0 };
    g.votes.push(c.vote);
    g.n += c.n;
    groups.set(key, g);
  }
  const segs = VOTE_SEGMENTS.filter((k) => groups.has(k)).map((key) => ({ key, ...groups.get(key)!, tenths: 0 }));
  const total = segs.reduce((s, x) => s + x.n, 0);
  if (total === 0) return [];

  // Largest remainder: floor every share, then hand the missing tenths to the largest remainders (earlier first on ties).
  const exact = segs.map((s) => (s.n * 1000) / total);
  segs.forEach((s, i) => (s.tenths = Math.floor(exact[i])));
  let left = 1000 - segs.reduce((s, x) => s + x.tenths, 0);
  const byRemainder = segs.map((_, i) => i).sort((a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])) || a - b);
  for (const i of byRemainder) {
    if (left <= 0) break;
    segs[i].tenths += 1;
    left -= 1;
  }

  // Keep every present vote visible, taking the difference from the widest segment that can spare it.
  for (const s of segs) {
    while (s.tenths < MIN_TENTHS) {
      const donor = segs.filter((d) => d !== s && d.tenths > MIN_TENTHS).sort((a, b) => b.tenths - a.tenths)[0];
      if (!donor) break;
      const give = Math.min(MIN_TENTHS - s.tenths, donor.tenths - MIN_TENTHS);
      donor.tenths -= give;
      s.tenths += give;
    }
  }
  return segs;
}

/** Sums each vote label over the parties (a roll call's whole split from its party groups). */
export function sumCounts(groups: { counts: { vote: string; n: number }[] }[]): { vote: string; n: number }[] {
  const all = new Map<string, number>();
  for (const g of groups) for (const c of g.counts) all.set(c.vote, (all.get(c.vote) ?? 0) + c.n);
  return [...all].map(([vote, n]) => ({ vote, n }));
}
