/**
 * Client-safe rules for recorded votes, as published. Nothing here judges a vote: a request ("requerimento": to postpone,
 * for urgency, to withdraw…) is marked because a "Não" on it is easily misread as a vote on the bill itself, and a
 * party's guidance is looked up only to show it next to the vote.
 */

/** The description of a roll call that votes a request, in JavaScript and in Postgres (`~*`): the same rule. */
const REQUEST = /^\s*(?:(?:aprovad|rejeitad|mantid|retirad)[oa]s?\s+(?:o|a|os|as)\s+)?requerimentos?\b/i;
export const REQUEST_DESCRIPTION_PG = String.raw`^\s*(?:(?:aprovad|rejeitad|mantid|retirad)[oa]s?\s+(?:o|a|os|as)\s+)?requerimentos?\y`;
/** A request's own bill label ("REQ 4063/2026"), in JavaScript and in Postgres (`~`). */
const REQUEST_LABEL = /^REQ\s/;
export const REQUEST_LABEL_PG = String.raw`^REQ\s`;

/** The roll call voted a request: its bill is a REQ, or the published description starts with one. */
export const isRequestVote = (description: string, billLabel: string | null) =>
  REQUEST_LABEL.test(billLabel ?? "") || REQUEST.test(description);

/** The deputy page's vote filter (`vv`) and the vote label it matches, as published. "Artigo 17" (the chair) has none. */
export const VOTE_FILTERS = { sim: "Sim", nao: "Não", abstencao: "Abstenção", obstrucao: "Obstrução" } as const;
export type VoteFilter = keyof typeof VOTE_FILTERS;

/** Guidance a vote can differ from; an empty guidance or "Liberado" (a free vote) never counts. */
export const DIRECTED_GUIDANCE = ["Sim", "Não", "Obstrução", "Abstenção"] as const;

/** Accents, case and punctuation aside: "Missão" and "MISSÃO" are one name. */
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Government, majority, opposition and minority leaders: their guidance is never a party's. */
const COALITIONS = new Set(["GOVERNO", "MAIORIA", "MINORIA", "OPOSICAO"]);

/**
 * Whether a short name in a published label is this party: the same name, or (3 letters or more) the start of exactly
 * one known party's name when it isn't a party's full name itself ("Solidaried", "Uni", "Avan"; "Psd" is PSD, never PSDB).
 */
function names(token: string, party: string, known: string[]): boolean {
  const t = norm(token);
  const p = norm(party);
  if (!t || !p) return false;
  if (t === p) return true;
  if (t.length < 3 || known.some((k) => norm(k) === t)) return false;
  const starts = new Set(known.map(norm).filter((k) => k.startsWith(t)));
  return starts.size === 1 && starts.has(p);
}

/**
 * The guidance labels that speak for `party` (the party at the vote), the closest first: its own label (`rank` 0), a
 * federation listing it ("Fdr PT-PCdoB-PV", 1), a bloc whose published name shows it ("Bl UniPpPsd...", 2: the name is
 * cut short, so only the parties written before "..." are known). Government, majority, opposition and minority never
 * are. `known`: every party name of the house, so a cut-short name is matched only when it can be one party alone.
 */
export function guidanceLabels(party: string, labels: string[], known: string[]): { label: string; rank: number }[] {
  const out: { label: string; rank: number }[] = [];
  for (const label of new Set(labels)) {
    const l = label.trim();
    if (COALITIONS.has(norm(l))) continue;
    let rank: number;
    let tokens: string[];
    if (/^Fdr\s/i.test(l)) {
      rank = 1;
      tokens = l.replace(/^Fdr\s+/i, "").split("-");
    } else if (/^Bl\s/i.test(l)) {
      rank = 2;
      tokens = l.replace(/^Bl\s+/i, "").replace(/(\.\.\.|…)$/, "").split(/(?=[A-Z])/);
    } else {
      rank = 0;
      tokens = [l.replace(/(\.\.\.|…)$/, "")];
    }
    if (tokens.some((t) => names(t, party, known))) out.push({ label, rank });
  }
  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/** A party bloc or federation as the Câmara API lists it (`parl_blocs`), with its member parties (empty: dissolved). */
export type StoredBloc = { name: string; federation: boolean; parties: string[] };

const blocTokens = (label: string) => label.trim().replace(/^Bl\s+/i, "").replace(/(\.\.\.|…)$/, "").split(/(?=[A-Z])/).filter(Boolean);

/**
 * The stored bloc a cut-short guidance label stands for ("Bl UniPpPsd..." → "UNIÃO, PP, PSD, REPUBLICANOS, MDB, …"):
 * the label's pieces name the first parties of the bloc's published name, in order (the same piece rule as
 * `guidanceLabels`; the last piece may be cut). Only a bloc (never a federation), and only when exactly one fits.
 */
export function linkBloc(label: string, blocs: StoredBloc[], known: string[]): StoredBloc | null {
  if (!/^Bl\s/i.test(label.trim())) return null;
  const tokens = blocTokens(label);
  if (tokens.length === 0) return null;
  // the blocs' own members and listed names count as party names too (a party with no deputy in the data yet)
  const all = [...new Set([...known, ...blocs.flatMap((b) => [...b.parties, ...b.name.split(/\s*,\s*/).filter((n) => !/\s/.test(n))])])];
  const fits = blocs.filter((b) => {
    if (b.federation) return false;
    const parts = b.name.split(/\s*,\s*/);
    return tokens.length <= parts.length && tokens.every((t, i) => names(t, parts[i]!, all) || (i === tokens.length - 1 && norm(t).length >= 3 && norm(parts[i]!).startsWith(norm(t))));
  });
  return fits.length === 1 ? fits[0]! : null;
}

/**
 * The guidance labels that speak for `party`, as `guidanceLabels`, except that a bloc label linked to a stored bloc
 * with members (`linkBloc`) applies exactly to those members, whatever its cut-short name shows: the guidance of
 * "Bl UniPpPsd..." reaches MDB, REPUBLICANOS, PODE, PSDB and CIDADANIA. `source`: where the guidance came from, as
 * shown to the reader (null for the party's own label; a federation's label; a linked bloc's full published name, else
 * the bloc's label as published).
 */
export function applicableGuidance(
  party: string, labels: string[], known: string[], blocs: StoredBloc[],
): { label: string; rank: number; source: string | null }[] {
  const out: { label: string; rank: number; source: string | null }[] = [];
  const p = norm(party);
  for (const label of new Set(labels)) {
    const bloc = blocs.length > 0 ? linkBloc(label, blocs, known) : null;
    if (bloc && bloc.parties.length > 0) {
      if (p && bloc.parties.some((m) => norm(m) === p)) out.push({ label, rank: 2, source: bloc.name });
      continue;
    }
    for (const g of guidanceLabels(party, [label], known)) out.push({ ...g, source: g.rank === 0 ? null : g.label });
  }
  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}
