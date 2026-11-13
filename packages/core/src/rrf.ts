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
