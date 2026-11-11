import { searchMembers, searchRollCalls, searchSpeeches, type Db, type MemberRow, type RollCallHit, type SpeechHit } from "@digestor/core/server";

export const MAX_QUERY = 200;
export const SEARCH_PAGE = 20;
export const MEMBER_PAGE = 50;

/** What the query translator returns (`translateQuery`); `failed` means the terms are the query as typed. */
export type TranslateResult = { terms: string[]; translated: boolean; failed: boolean };
export type Translate = (q: string) => Promise<TranslateResult>;

export type Searched = { q: string; terms: string[]; translatedFrom: string | null; notice: "translationFailed" | null };
export type SearchResult = Searched & {
  members: MemberRow[]; speeches: { total: number; rows: SpeechHit[] }; rollCalls: RollCallHit[];
};

export const cleanQuery = (q: string) => q.trim().slice(0, MAX_QUERY);

/** The query's search terms: translated when a translator is given, else the words as typed. */
export async function searchTerms(q: string, translate?: Translate): Promise<Searched> {
  if (!q) return { q, terms: [], translatedFrom: null, notice: null };
  const r = translate ? await translate(q) : { terms: [q], translated: false, failed: false };
  return { q, terms: r.terms, translatedFrom: r.translated ? q : null, notice: r.failed ? "translationFailed" : null };
}

/**
 * One search box: deputies by name (the query as typed), speeches and roll calls by the (translated) terms.
 * An empty query touches nothing.
 */
export async function runSearch(db: Db, raw: string, translate?: Translate, a: { page?: number } = {}): Promise<SearchResult> {
  const searched = await searchTerms(cleanQuery(raw), translate);
  if (!searched.q) return { ...searched, members: [], speeches: { total: 0, rows: [] }, rollCalls: [] };
  const [members, speeches, rollCalls] = await Promise.all([
    searchMembers(db, searched.q),
    searchSpeeches(db, { terms: searched.terms, limit: SEARCH_PAGE, offset: (a.page ?? 0) * SEARCH_PAGE }),
    searchRollCalls(db, { terms: searched.terms }),
  ]);
  return { ...searched, members, speeches, rollCalls };
}

/** A non-negative page number from a query parameter. */
export function pageParam(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : 0;
}

export function stringParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** The current monitor URL (path + query), for the language switch to come back to. */
export function backPath(path: string, params: Record<string, string | string[] | undefined>): string {
  const sp = new URLSearchParams();
  for (const k of ["q", "p"]) {
    const v = stringParam(params[k]);
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

export const deputyUrl = (externalId: number) => `https://www.camara.leg.br/deputados/${externalId}`;
export const billUrl = (billId: number) => `https://www.camara.leg.br/propostas-legislativas/${billId}`;
