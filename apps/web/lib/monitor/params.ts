import { cleanQuery, pageParam } from "./search";

/**
 * Every monitor URL parameter is parsed here, and every monitor link is built here. Anything a person can type into a
 * URL (a date outside the year, `party=';--`, `p=-1`, a repeated key) is ignored or normalised, never an error.
 */
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
  };
}

export type DeputyParams = {
  q: string; rel: "by" | "mentions"; from: string | null; to: string | null; phase: string | null; sort: "best" | "new"; year: number;
  p: number; btype: string | null; bp: number;
};

export function parseDeputy(sp: RawParams): DeputyParams {
  const year = yearParam(sp.year);
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
  };
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
    ["q", p.q], ["show", show], ["from", p.from], ["to", p.to], ["party", p.party], ["uf", p.uf], ["phase", p.phase],
    ["inOffice", p.inOffice ? "1" : null], ["sort", p.sort === "new" ? "new" : null], ["year", p.year && p.year !== DEFAULT_YEAR ? p.year : null],
    ["p", p.p], ["rp", p.rp],
  ]);
}

/** A deputy's page with only the non-default values, keys in a fixed order. */
export function deputyHref(externalId: number, p: Partial<DeputyParams> = {}): string {
  return href(`/monitor/deputados/${externalId}`, [
    ["q", p.q], ["rel", p.rel === "mentions" ? "mentions" : null], ["from", p.from], ["to", p.to], ["phase", p.phase],
    ["sort", p.sort === "new" ? "new" : null], ["year", p.year && p.year !== DEFAULT_YEAR ? p.year : null], ["p", p.p],
    ["btype", p.btype], ["bp", p.bp],
  ]);
}

export const rollCallHref = (id: string) => `/monitor/votacoes/${id}`;
export const isRollCallId = (id: string) => /^\d{1,9}-\d{1,4}$/.test(id);
