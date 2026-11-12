/**
 * Client-safe helpers for recorded votes, as published. Nothing here judges a vote: a request ("requerimento": to
 * postpone, for urgency, to withdraw…) is marked because a "Não" on it is easily misread as a vote on the bill itself.
 */
const REQUEST = /^\s*(?:(?:aprovad|rejeitad|mantid|retirad)[oa]s?\s+(?:o|a|os|as)\s+)?requerimentos?\b/i;

/** The roll call voted a request: its bill is a REQ, or the published description starts with one. */
export const isRequestVote = (description: string, billLabel: string | null) =>
  /^REQ\s/.test(billLabel ?? "") || REQUEST.test(description);

/** Deputies in the order to read them: the smallest vote group first (who voted apart from the party), then by name. */
export function bySmallestGroup<T extends { name: string; vote: string }>(deputies: T[]): T[] {
  const size = new Map<string, number>();
  for (const d of deputies) size.set(d.vote, (size.get(d.vote) ?? 0) + 1);
  return [...deputies].sort(
    (a, b) => size.get(a.vote)! - size.get(b.vote)! || a.vote.localeCompare(b.vote, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"),
  );
}
