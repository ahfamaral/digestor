import { fuseRecords, phraseTerms, rrf, typedPhrase } from "@digestor/core";
import {
  filterSpeechKeys, listMemberBills, listMemberVotes, memberBillIds, memberVoteIds, searchRollCalls, searchSpeeches, speechesByKeys, speechKeysByWords,
  type Db, type MemberBill, type MemberVoteFilters, type RollCallHit, type SpeechFilters, type SpeechHit, type VoteRow,
} from "@digestor/core/server";
import type { LandingParams } from "./params";
import type { RecordKindParam, RecordSearchResult, SemanticResult } from "./semantic";

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
/** The worker's search by meaning (`semanticSearch`); `ok: false` when it can't answer. */
export type Semantic = (q: string) => Promise<SemanticResult>;
/**
 * `byMeaning`: found by the search by meaning only (none of the searched words), marked "Close in meaning": it may not
 * be about the topic, so it is never counted as a match.
 */
export type LandingSpeech = SpeechHit & { byMeaning?: boolean };
/**
 * A group the person chose not to show is null. `meaning`: "used" (speeches fused with the search by meaning),
 * "unavailable" (the worker didn't answer: word results only, with a quiet note) or "off" (exact words, newest first,
 * or no speeches shown).
 */
export type LandingResult = Searched & {
  /** `total`: every row listed (paging); `meaningOnly`: those only the search by meaning found (part of `total`, never matches). */
  speeches: { total: number; rows: LandingSpeech[]; meaningOnly?: number } | null; rollCalls: { total: number; rows: RollCallHit[] } | null;
  meaning: "used" | "unavailable" | "off";
};

/** How many of each ranking are fused (Reciprocal Rank Fusion); word matches beyond that follow in word order. */
export const FUSE_TOP = 100;
/** Every word match's key is read once (cheap: keys only) so the fused list and the rest page without repeats. */
const ALL_WORD_KEYS = 20_000;


/** The query's search terms: translated when a translator is given (and not `exact`), else the words as typed. */
export async function searchTerms(q: string, translate?: Translate, exact = false): Promise<Searched> {
  if (!q) return { q, terms: [], translatedFrom: null, notice: null, exact };
  const r = translate && !exact ? await translate(q) : { terms: [q], translated: false, failed: false };
  return { q, terms: r.terms, translatedFrom: r.translated ? q : null, notice: r.failed ? "translationFailed" : null, exact };
}

export { typedPhrase };

/** The search terms as full-text queries (`phraseTerms`, shared with the worker's search evaluation). */
export function queryTerms(s: Searched): string[] {
  return phraseTerms(s.q, s.terms);
}

/**
 * The landing's topic search: speeches (filtered, paged by `p`) and roll calls (dates only, paged by `rp`) by the
 * (translated) terms. Deputies are found by the combobox, not here. An empty query touches nothing.
 */
export async function runSearch(db: Db, p: LandingParams, translate?: Translate, semantic?: Semantic): Promise<LandingResult> {
  const q = cleanQuery(p.q);
  // Speeches under "Best match" also search by meaning (the typed query; the e5 model reads any language), in
  // parallel with the translation. Exact words and "Newest first" stay word-only.
  const useMeaning = !!semantic && !!q && p.show.speeches && !p.exact && p.sort === "best";
  const [searched, meaning] = await Promise.all([searchTerms(q, translate, p.exact), useMeaning ? semantic(q) : null]);
  const empty = { total: 0, rows: [] };
  if (!searched.q) {
    return { ...searched, speeches: p.show.speeches ? empty : null, rollCalls: p.show.rollCalls ? empty : null, meaning: "off" };
  }
  const terms = queryTerms(searched);
  const phrase = typedPhrase(searched.q);
  const filters = {
    from: p.from ?? undefined, to: p.to ?? undefined, party: p.party ?? undefined, uf: p.uf ?? undefined, phase: p.phase ?? undefined,
    inOffice: p.inOffice || undefined,
  };
  const page = { limit: SEARCH_PAGE, offset: p.p * SEARCH_PAGE };
  const [speeches, rollCalls] = await Promise.all([
    !p.show.speeches
      ? null
      : meaning?.ok
        ? hybridSpeeches(db, { terms, phrase, filters, meaningKeys: meaning.keys, ...page })
        : searchSpeeches(db, { terms, phrase, filters, sort: p.sort, ...page }),
    p.show.rollCalls
      ? searchRollCalls(db, { terms, phrase, from: filters.from, to: filters.to, sort: p.sort, limit: SEARCH_PAGE, offset: p.rp * SEARCH_PAGE })
      : null,
  ]);
  return { ...searched, speeches, rollCalls, meaning: !meaning ? "off" : meaning.ok ? "used" : "unavailable" };
}

/**
 * Word and meaning results as one list: the top `FUSE_TOP` of each (meaning hits through the same filters) fused by
 * Reciprocal Rank Fusion, then the remaining word matches in word order; paged over that list, so a page never
 * repeats or skips a speech. Rows only the meaning search found are marked `byMeaning` and counted apart
 * (`meaningOnly`): interleaved by RRF (measured better than after the word matches), but never counted as matches.
 */
export async function hybridSpeeches(
  db: Db, a: { terms: string[]; phrase?: string; filters: SpeechFilters; meaningKeys: string[]; limit: number; offset: number },
): Promise<{ total: number; rows: LandingSpeech[]; meaningOnly: number }> {
  const [words, meaning] = await Promise.all([
    speechKeysByWords(db, { terms: a.terms, phrase: a.phrase, filters: a.filters, limit: ALL_WORD_KEYS }),
    filterSpeechKeys(db, a.meaningKeys.slice(0, FUSE_TOP), a.filters),
  ]);
  const fused = rrf([words.keys.slice(0, FUSE_TOP), meaning]).map((r) => r.key);
  const inFused = new Set(fused);
  const list = [...fused, ...words.keys.slice(FUSE_TOP).filter((k) => !inFused.has(k))];
  const pageKeys = list.slice(a.offset, a.offset + a.limit);
  const wordKeys = new Set(words.keys);
  const rows = await speechesByKeys(db, pageKeys, {}, { terms: a.terms });
  return {
    total: list.length, rows: rows.map((r) => ({ ...r, byMeaning: !wordKeys.has(r.speechKey ?? "") })), meaningOnly: list.length - words.keys.length,
  };
}


// ── A deputy's vote and bill text boxes ──────────────────────────────────────────────────────────────────────────

/** The worker's search by meaning over a deputy's own roll calls or bills (`recordSearch`); `ok: false` when it can't answer. */
export type RecordSemantic = (kind: RecordKindParam, q: string, ids: string[]) => Promise<RecordSearchResult>;
/**
 * The deputy's records sent to be ranked by meaning at most, per kind: the worker's limits (`http.ts`, sized for its
 * 64 KB body: a roll-call id is longer than a bill id).
 */
const MAX_RECORD_IDS = { rollCalls: 3000, bills: 5000 } as const;
/**
 * "used": the word matches, then the rows only the search by meaning found; "unavailable": the worker didn't answer
 * (word matches only, quiet note); "words": exact words (no meaning), best match first; "off": no text.
 */
export type RecordMeaning = "used" | "unavailable" | "words" | "off";
export type DeputyVote = VoteRow & { byMeaning?: boolean };
export type DeputyBill = MemberBill & { byMeaning?: boolean };

/**
 * The search by meaning for the votes text box, started beside the query translation (the e5 model reads the typed
 * words in any language): the deputy's votes that pass the other filters, ranked by the worker.
 */
export async function voteMeaning(
  db: Db, memberId: number, filters: Omit<MemberVoteFilters, "q">, q: string, semantic: RecordSemantic,
): Promise<RecordSearchResult> {
  const ids = await memberVoteIds(db, memberId, filters);
  return semantic("rollCalls", q, ids.slice(0, MAX_RECORD_IDS.rollCalls));
}

/** The same for the bills text box: the deputy's bills of the year filter (every type: the counts by type cover them all). */
export async function billMeaning(db: Db, memberId: number, a: { year?: number }, q: string, semantic: RecordSemantic): Promise<RecordSearchResult> {
  const ids = await memberBillIds(db, memberId, { year: a.year });
  return semantic("bills", q, ids.slice(0, MAX_RECORD_IDS.bills).map(String));
}

const meaningState = (m: RecordSearchResult | null): RecordMeaning => (!m ? "words" : m.ok ? "used" : "unavailable");

/**
 * The votes text box: the word matches, best first (RRF lifts the ones the search by meaning found too), then the
 * closest votes only the meaning search found (`fuseRecords`), every other filter applied to both, paged over that list.
 * Those rows are marked `byMeaning` and counted apart (`meaningOnly`): they may not be about the topic, so they never
 * count as matches. `meaning` null (exact words) or a worker that didn't answer: the word matches only, best first.
 */
export async function hybridVotes(
  db: Db, memberId: number,
  a: { terms: string[]; phrase?: string; filters: Omit<MemberVoteFilters, "q">; meaning: RecordSearchResult | null; limit: number; offset: number },
): Promise<Omit<Awaited<ReturnType<typeof listMemberVotes>>, "rows"> & { rows: DeputyVote[]; meaning: RecordMeaning; meaningOnly: number }> {
  const words = await memberVoteIds(db, memberId, { ...a.filters, q: a.terms, phrase: a.phrase });
  const { list, meaningOnly } = a.meaning?.ok ? fuseRecords(words, a.meaning.hits) : { list: words, meaningOnly: [] };
  const r = await listMemberVotes(db, memberId, { ...a.filters, ids: list, limit: a.limit, offset: a.offset });
  const only = new Set(meaningOnly);
  return {
    ...r, rows: r.rows.map((v) => ({ ...v, byMeaning: only.has(v.rollCallId) })), meaning: meaningState(a.meaning),
    meaningOnly: r.total - words.length,
  };
}

/** The bills text box, as `hybridVotes`; the type filter and the counts by type cover the whole list shown. */
export async function hybridBills(
  db: Db, memberId: number,
  a: { terms: string[]; phrase?: string; type?: string; year?: number; meaning: RecordSearchResult | null; limit: number; offset: number },
): Promise<Omit<Awaited<ReturnType<typeof listMemberBills>>, "rows"> & { rows: DeputyBill[]; meaning: RecordMeaning; meaningOnly: number }> {
  const words = (await memberBillIds(db, memberId, { q: a.terms, phrase: a.phrase, year: a.year })).map(String);
  const { list, meaningOnly } = a.meaning?.ok ? fuseRecords(words, a.meaning.hits) : { list: words, meaningOnly: [] };
  const filters = { type: a.type, year: a.year };
  const [r, only] = await Promise.all([
    listMemberBills(db, memberId, { ...filters, ids: list.map(Number), limit: a.limit, offset: a.offset }),
    meaningOnly.length ? listMemberBills(db, memberId, { ...filters, ids: meaningOnly.map(Number), limit: 0 }) : null,
  ]);
  const marked = new Set(meaningOnly);
  return {
    ...r, rows: r.rows.map((b) => ({ ...b, byMeaning: marked.has(String(b.id)) })), meaning: meaningState(a.meaning), meaningOnly: only?.total ?? 0,
  };
}


export const deputyUrl = (externalId: number) => `https://www.camara.leg.br/deputados/${externalId}`;
export const billUrl = (billId: number) => `https://www.camara.leg.br/propostas-legislativas/${billId}`;
