/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009): each list adds 1 / (k + rank) for every key it holds
 * (rank from 1), so a key several lists agree on rises above a key only one list ranks high. Scores need not be
 * comparable across lists (full-text rank vs cosine), only the order. Ties keep the order of first appearance, reading
 * the lists rank by rank (list 0's first item, list 1's first item, then the second items…). A key repeated inside one
 * list counts once, at its best rank. `inLists`: the indexes of the lists that hold the key.
 */
export function rrf(lists: string[][], k = 60): { key: string; score: number; inLists: number[] }[] {
  const out = new Map<string, { key: string; score: number; inLists: number[]; first: number }>();
  const depth = Math.max(0, ...lists.map((l) => l.length));
  let seen = 0;
  for (let rank = 0; rank < depth; rank++) {
    for (const [li, list] of lists.entries()) {
      const key = list[rank];
      if (key === undefined) continue;
      const row = out.get(key) ?? { key, score: 0, inLists: [], first: seen++ };
      if (row.inLists.includes(li)) continue;
      row.score += 1 / (k + rank + 1);
      row.inLists.push(li);
      out.set(key, row);
    }
  }
  return [...out.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map(({ key, score, inLists }) => ({ key, score, inLists: inLists.sort((a, b) => a - b) }));
}

/**
 * Meaning hits a deputy's vote or bill text box keeps: the deputy's own records are ranked whole (every vote gets a
 * score, and e5's cosine scores bunch between about 0.75 and 0.9 whatever the query), so only the closest few join the
 * word matches: at most `top`, each within `within` of the best hit and at least `min`. Calibrated on the golden
 * queries (`apps/worker/eval/monitor-records.golden.json`, `--sweep`; docs/capstone/evaluation.md): within 0.03 kept the
 * recall of a 0.8 floor (0.74) at a higher precision@10 (0.71 against 0.59) and follows English queries, which score lower.
 */
export const RECORD_MEANING = { top: 10, within: 0.03, min: 0.75, fuse: 100 };

/**
 * A vote or bill text box's list. Word matches always come first: the top `fuse` of them in RRF order with the meaning
 * hits that pass the cut (`top` best, within `within` of the best, at least `min`), so a word match the meaning search
 * also found rises, then the remaining word matches in word order. The hits only the meaning search found
 * (`meaningOnly`, marked "close in meaning": they may not be about the topic) follow every word match, in meaning order.
 */
export function fuseRecords(
  words: string[], meaning: { id: string; score: number }[],
  o: { top: number; min: number; within?: number; fuse?: number } = RECORD_MEANING,
): { list: string[]; meaningOnly: string[] } {
  const best = meaning.reduce((m, h) => Math.max(m, h.score), Number.NEGATIVE_INFINITY);
  const floor = Math.max(o.min, o.within === undefined ? Number.NEGATIVE_INFINITY : best - o.within);
  const kept = meaning.filter((m) => m.score >= floor).slice(0, o.top).map((m) => m.id);
  const fuse = o.fuse ?? RECORD_MEANING.fuse;
  const head = words.slice(0, fuse);
  const inHead = new Set(head);
  const fused = rrf([head, kept]).map((r) => r.key).filter((k) => inHead.has(k));
  const wordSet = new Set(words);
  const meaningOnly = kept.filter((id) => !wordSet.has(id));
  return { list: [...fused, ...words.slice(fuse).filter((w) => !inHead.has(w)), ...meaningOnly], meaningOnly };
}
