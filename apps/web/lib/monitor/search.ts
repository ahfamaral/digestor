import { normName } from "@digestor/core";
import { searchRollCalls, searchSpeeches, type Db, type RollCallHit, type SpeechHit } from "@digestor/core/server";
import type { LandingParams } from "./params";

import { cleanQuery } from "./params";

export { cleanQuery, MAX_QUERY, pageParam, stringParam } from "./params";
export const SEARCH_PAGE = 20;
export const MEMBER_PAGE = 20;
/** A deputy's recorded votes per page. */
export const VOTE_PAGE = 20;

/** What the query translator returns (`translateQuery`); `failed` means the terms are the query as typed. */
export type TranslateResult = { terms: string[]; translated: boolean; failed: boolean };
export type Translate = (q: string) => Promise<TranslateResult>;

/** `exact`: the words as typed only (no translation, no related terms). */
export type Searched = { q: string; terms: string[]; translatedFrom: string | null; notice: "translationFailed" | null; exact: boolean };
/** A group the person chose not to show is null. */
export type LandingResult = Searched & {
  speeches: { total: number; rows: SpeechHit[] } | null; rollCalls: { total: number; rows: RollCallHit[] } | null;
};


/** The query's search terms: translated when a translator is given (and not `exact`), else the words as typed. */
export async function searchTerms(q: string, translate?: Translate, exact = false): Promise<Searched> {
  if (!q) return { q, terms: [], translatedFrom: null, notice: null, exact };
  const r = translate && !exact ? await translate(q) : { terms: [q], translated: false, failed: false };
  return { q, terms: r.terms, translatedFrom: r.translated ? q : null, notice: r.failed ? "translationFailed" : null, exact };
}

/** The typed words, ranked first when they appear together (`phrase` of the core searches); one word needs no boost. */
export const typedPhrase = (q: string): string | undefined => {
  const words = q.replace(/["()]/g, " ").trim();
  return /\s/.test(words) ? words : undefined;
};

/**
 * The terms as full-text queries: what the person typed keeps its search syntax (quotes, OR, -word); a translated
 * multi-word term is a phrase, so "violência contra a mulher" doesn't match those words scattered over a speech.
 */
export function queryTerms(s: Searched): string[] {
  const typed = normName(s.q);
  return s.terms.map((t) => (normName(t) === typed || !/\s/.test(t.trim()) ? t : `"${t.replace(/"/g, "")}"`));
}

/**
 * The landing's topic search: speeches (filtered, paged by `p`) and roll calls (dates only, paged by `rp`) by the
 * (translated) terms. Deputies are found by the combobox, not here. An empty query touches nothing.
 */
export async function runSearch(db: Db, p: LandingParams, translate?: Translate): Promise<LandingResult> {
  const searched = await searchTerms(cleanQuery(p.q), translate, p.exact);
  const empty = { total: 0, rows: [] };
  if (!searched.q) return { ...searched, speeches: p.show.speeches ? empty : null, rollCalls: p.show.rollCalls ? empty : null };
  const terms = queryTerms(searched);
  const phrase = typedPhrase(searched.q);
  const filters = {
    from: p.from ?? undefined, to: p.to ?? undefined, party: p.party ?? undefined, uf: p.uf ?? undefined, phase: p.phase ?? undefined,
    inOffice: p.inOffice || undefined,
  };
  const [speeches, rollCalls] = await Promise.all([
    p.show.speeches ? searchSpeeches(db, { terms, phrase, filters, sort: p.sort, limit: SEARCH_PAGE, offset: p.p * SEARCH_PAGE }) : null,
    p.show.rollCalls
      ? searchRollCalls(db, { terms, phrase, from: filters.from, to: filters.to, sort: p.sort, limit: SEARCH_PAGE, offset: p.rp * SEARCH_PAGE })
      : null,
  ]);
  return { ...searched, speeches, rollCalls };
}


export const deputyUrl = (externalId: number) => `https://www.camara.leg.br/deputados/${externalId}`;
export const billUrl = (billId: number) => `https://www.camara.leg.br/propostas-legislativas/${billId}`;
