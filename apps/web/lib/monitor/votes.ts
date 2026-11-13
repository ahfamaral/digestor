/**
 * Client-safe helpers for recorded votes, as published. Nothing here judges a vote. The request rule lives in core
 * (`isRequestVote`), where the deputy page's "kind" filter uses the same rule in SQL.
 */
export { isRequestVote } from "@digestor/core";

/** Deputies in the order to read them: the smallest vote group first (who voted apart from the party), then by name. */
export function bySmallestGroup<T extends { name: string; vote: string }>(deputies: T[]): T[] {
  const size = new Map<string, number>();
  for (const d of deputies) size.set(d.vote, (size.get(d.vote) ?? 0) + 1);
  return [...deputies].sort(
    (a, b) => size.get(a.vote)! - size.get(b.vote)! || a.vote.localeCompare(b.vote, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"),
  );
}
