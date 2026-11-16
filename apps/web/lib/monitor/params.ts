/**
 * Every monitor URL parameter is parsed here, and every monitor link is built here. Anything a person can type into a
 * URL (a date outside the year, `party=';--`, `p=-1`, a repeated key) is ignored or normalised, never an error.
 * Client-safe: the deputy combobox and the year select load it in the browser, so it never imports server code.
 */
export const MAX_QUERY = 200;

/** Control characters out (a NUL makes Postgres throw), spaces collapsed, capped. */
export const cleanQuery = (q: string) => q.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);

/** A non-negative page number from a query parameter. */
export function pageParam(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : 0;
}

export function stringParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}
export const MONITOR_YEARS = [2026] as const;
const DEFAULT_YEAR = 2026;

type Raw = string | string[] | undefined;
export type RawParams = Record<string, Raw>;

const first = (v: Raw): string | undefined => (Array.isArray(v) ? v[0] : v);
const all = (v: Raw): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** A monitored year; anything else is 2026. */
export function yearParam(v: Raw): number {
  const n = Number(first(v));
  return (MONITOR_YEARS as readonly number[]).includes(n) ? n : DEFAULT_YEAR;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real `YYYY-MM-DD` inside `year`, else null. */
function dateParam(v: Raw, year: number): string | null {
  const s = first(v);
  const m = s ? DATE.exec(s) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number(m[1]) === year && d.toISOString().slice(0, 10) === s ? s : null;
}

/** Both dates, swapped when `from` is after `to`. */
function range(sp: RawParams, year: number): { from: string | null; to: string | null } {
  const from = dateParam(sp.from, year);
  const to = dateParam(sp.to, year);
  return from && to && from > to ? { from: to, to: from } : { from, to };
}

const PARTY = /^[\p{L}\d ._-]{1,30}$/u;
const UF = /^[A-Z]{2}$/;
const cleaned = (v: Raw, max: number): string | null => cleanQuery(first(v) ?? "").slice(0, max).trim() || null;
const sortParam = (v: Raw): "best" | "new" => (first(v) === "new" ? "new" : "best");

export type LandingParams = {
  q: string; show: { speeches: boolean; rollCalls: boolean }; from: string | null; to: string | null; party: string | null;
  uf: string | null; phase: string | null; inOffice: boolean; sort: "best" | "new"; year: number; p: number; rp: number;
  /** Search the words exactly as typed: no translation, no related terms. */
  exact: boolean;
};

export function parseLanding(sp: RawParams): LandingParams {
  const year = yearParam(sp.year);
  const shown = all(sp.show);
  const speeches = shown.includes("speeches");
  const rollCalls = shown.includes("rollcalls");
  const party = (first(sp.party) ?? "").trim();
  const uf = first(sp.uf) ?? "";
  return {
    q: cleanQuery(first(sp.q) ?? ""),
    show: speeches || rollCalls ? { speeches, rollCalls } : { speeches: true, rollCalls: true },
    ...range(sp, year),
    party: PARTY.test(party) ? party : null,
    uf: UF.test(uf) ? uf : null,
    phase: cleaned(sp.phase, 120),
    inOffice: first(sp.inOffice) === "1",
    sort: sortParam(sp.sort),
    year,
    p: pageParam(sp.p),
    rp: pageParam(sp.rp),
    exact: first(sp.exact) === "1",
  };
}

/**
 * How many of the topic search's filters narrow it (dates, party, state, phase, in office, one group hidden): the
 * number on the folded "Filters (n)" once a search has run.
 */
export function activeTopicFilters(p: LandingParams): number {
  return [p.from, p.to, p.party, p.uf, p.phase, p.inOffice || null, p.show.speeches && p.show.rollCalls ? null : "show"].filter(Boolean).length;
}

/** "Ask the record" (`/monitor/perguntar`): the question and the speeches' dates (inside the default year). */
export type AskParams = { q: string; from: string | null; to: string | null };

export function parseAsk(sp: RawParams): AskParams {
  return { q: cleanQuery(first(sp.q) ?? ""), ...range(sp, DEFAULT_YEAR) };
}

/** The "Ask the record" page with only the values set. */
export const askHref = (p: Partial<AskParams> = {}) => href("/monitor/perguntar", [["q", p.q], ["from", p.from], ["to", p.to]]);

/** The vote filter (`vv`): the vote labels as published, in the URL without accents. */
export const VOTE_VALUES = ["sim", "nao", "abstencao", "obstrucao"] as const;
export type VoteValue = (typeof VOTE_VALUES)[number];

export type DeputyParams = {
  q: string; rel: "by" | "mentions"; from: string | null; to: string | null; phase: string | null; sort: "best" | "new"; year: number;
  p: number; btype: string | null; bp: number; vp: number; exact: boolean;
  /** Bills: words in the summary (`bexact`: as typed), the year presented. */
  bq: string; bexact: boolean; byear: number | null;
  /** Votes: words in what was voted (`vexact`: as typed), the vote, a bill or a request, months "YYYY-MM", different from the party's guidance. */
  vq: string; vexact: boolean; vv: VoteValue | null; vk: "bill" | "request" | null; vfrom: string | null; vto: string | null; vdiff: boolean;
};

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** A `YYYY-MM` month of `year`, else null. */
function monthParam(v: Raw, year: number): string | null {
  const s = first(v);
  const m = s ? MONTH.exec(s) : null;
  return m && Number(m[1]) === year ? s! : null;
}

export function parseDeputy(sp: RawParams): DeputyParams {
  const year = yearParam(sp.year);
  const vv = first(sp.vv);
  const vk = first(sp.vk);
  const byear = first(sp.byear);
  const vfrom = monthParam(sp.vfrom, year);
  const vto = monthParam(sp.vto, year);
  const swap = vfrom && vto && vfrom > vto;
  return {
    q: cleanQuery(first(sp.q) ?? ""),
    rel: first(sp.rel) === "mentions" ? "mentions" : "by",
    ...range(sp, year),
    phase: cleaned(sp.phase, 120),
    sort: sortParam(sp.sort),
    year,
    p: pageParam(sp.p),
    btype: cleaned(sp.btype, 10),
    bp: pageParam(sp.bp),
    vp: pageParam(sp.vp),
    exact: first(sp.exact) === "1",
    bq: cleanQuery(first(sp.bq) ?? ""),
    bexact: first(sp.bexact) === "1",
    byear: byear && /^(19|20)\d\d$/.test(byear) ? Number(byear) : null,
    vq: cleanQuery(first(sp.vq) ?? ""),
    vexact: first(sp.vexact) === "1",
    vv: (VOTE_VALUES as readonly string[]).includes(vv ?? "") ? (vv as VoteValue) : null,
    vk: vk === "bill" || vk === "request" ? vk : null,
    vfrom: swap ? vto : vfrom,
    vto: swap ? vfrom : vto,
    vdiff: first(sp.vdiff) === "1",
  };
}

/**
 * What a section's form keeps of the page: every other section's state, as hidden fields. Its own fields come from the
 * form, and its list starts again on page 1 (a filter changed).
 */
export function keptBy(section: "speeches" | "bills" | "votes", p: DeputyParams): DeputyParams {
  if (section === "speeches") return { ...p, q: "", exact: false, rel: "by", from: null, to: null, phase: null, p: 0 };
  if (section === "bills") return { ...p, bq: "", bexact: false, byear: null, bp: 0 };
  return { ...p, vq: "", vexact: false, vv: null, vk: null, vfrom: null, vto: null, vdiff: false, vp: 0 };
}

/** The deputies directory: today's party and state; `former`: also the deputies not in office now. */
export type DirectoryParams = { party: string | null; uf: string | null; former: boolean };

export function parseDirectory(sp: RawParams): DirectoryParams {
  const party = (first(sp.party) ?? "").trim();
  const uf = first(sp.uf) ?? "";
  return { party: PARTY.test(party) ? party : null, uf: UF.test(uf) ? uf : null, former: first(sp.former) === "1" };
}

function href(path: string, pairs: [string, string | number | null | undefined | false][]): string {
  const sp = new URLSearchParams();
  for (const [k, v] of pairs) if (v !== null && v !== undefined && v !== false && v !== "" && v !== 0) sp.append(k, String(v));
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

/** `/monitor` with only the non-default values, keys in a fixed order. */
export function landingHref(p: Partial<LandingParams>): string {
  const show = p.show && p.show.speeches !== p.show.rollCalls ? (p.show.speeches ? "speeches" : "rollcalls") : null;
  return href("/monitor", [
    ["q", p.q], ["exact", p.exact ? "1" : null], ["show", show], ["from", p.from], ["to", p.to], ["party", p.party], ["uf", p.uf], ["phase", p.phase],
    ["inOffice", p.inOffice ? "1" : null], ["sort", p.sort === "new" ? "new" : null], ["year", p.year && p.year !== DEFAULT_YEAR ? p.year : null],
    ["p", p.p], ["rp", p.rp],
  ]);
}

/** A deputy's page with only the non-default values, keys in a fixed order. */
export function deputyHref(externalId: number, p: Partial<DeputyParams> = {}): string {
  return href(`/monitor/deputados/${externalId}`, [
    ["q", p.q], ["exact", p.exact ? "1" : null], ["rel", p.rel === "mentions" ? "mentions" : null], ["from", p.from], ["to", p.to], ["phase", p.phase],
    ["sort", p.sort === "new" ? "new" : null], ["year", p.year && p.year !== DEFAULT_YEAR ? p.year : null], ["p", p.p],
    ["bq", p.bq], ["bexact", p.bexact ? "1" : null], ["byear", p.byear], ["btype", p.btype], ["bp", p.bp],
    ["vq", p.vq], ["vexact", p.vexact ? "1" : null], ["vv", p.vv], ["vk", p.vk], ["vfrom", p.vfrom], ["vto", p.vto], ["vdiff", p.vdiff ? "1" : null],
    ["vp", p.vp],
  ]);
}

/** The deputies directory with only the non-default values. */
export const directoryHref = (p: Partial<DirectoryParams> = {}) =>
  href("/monitor/deputados", [["party", p.party], ["uf", p.uf], ["former", p.former ? "1" : null]]);

/**
 * A roll call's page. `from`: the deputy whose page it was opened from (its back link names them); `back`: the search it
 * was found by (its back link returns there, even where the browser can't go back in history).
 */
export const rollCallHref = (id: string, ctx: { from?: number; back?: string } = {}) =>
  href(`/monitor/votacoes/${id}`, [["from", ctx.from], ["back", ctx.from ? null : ctx.back]]);
/** The roll-call page's `back`: a monitor search address (`/monitor` with a query only), else null. */
export const backToSearch = (sp: RawParams): string | null => {
  const s = first(sp.back);
  return s && s.length <= 1000 && /^\/monitor(\?[^#\s]*)?$/.test(s) ? s : null;
};
/** The roll-call page's `from`: a Câmara deputy id, else null. */
export const fromDeputy = (sp: RawParams): number | null => {
  const s = first(sp.from);
  return s && /^[1-9]\d{0,8}$/.test(s) ? Number(s) : null;
};
export const isRollCallId = (id: string) => /^\d{1,9}-\d{1,4}$/.test(id);
