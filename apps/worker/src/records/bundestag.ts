import { XMLParser } from "fast-xml-parser";
import { normaliseName, type RecordRef } from "@digestor/core";
import type { MemberInfo, RecordConnector, RecordSpeech } from "./types.js";
import { RecordNotFoundError, notPublishedOrNotFound } from "./types.js";
import { ApiKeyRejectedError } from "../errors.js";
import { get } from "./http.js";

/**
 * Bundestag open data (https://www.bundestag.de/services/opendata). Shapes recorded 2026-11-04, see
 * test/fixtures/bundestag-* and `fakeBundestag.ts`.
 *  - The XML of a sitting lives at a blob URL with an internal id (`/resource/blob/1225450/21103.xml`) that can't be
 *    derived from the sitting number, so the connector reads the open-data page's AJAX list of the period
 *    (`/ajax/filterlist/de/services/opendata/<list id>?limit=10&offset=N&noFilterSet=true`, newest first, 10 per page,
 *    each sitting twice per page, "Plenarprotokoll der 103. Sitzung von Freitag, dem 16. Oktober 2026"). That is
 *    scraping: when the page stops yielding links the connector fails loudly, naming the list URL.
 *  - Fallback with `BUNDESTAG_DIP_API_KEY`: the DIP API `plenarprotokoll` (modelled on its docs, never called live).
 *  - Protocol: root `wahlperiode`, `sitzung-nr`, `sitzung-datum="16.10.2026"`. A speech is a `<p klasse="redner">` holding
 *    `<redner id>` (the MdB id; ministers carry `<rolle>` instead of `<fraktion>`), followed by its `<p>`s. The chair
 *    ("Präsidentin Julia Klöckner:") is a bare `<name>` element inside a `<rede>` or between redes and carries NO id.
 *    `<kommentar>` holds the applause and heckles and stays out of the text. No per-speech times.
 */
const AJAX = "https://www.bundestag.de/ajax/filterlist/de/services/opendata";
/** The open-data page's list ids by electoral period. */
const LIST_IDS: Record<number, string> = { 21: "1058442-1058442", 20: "866354-866354", 19: "543410-543410" };
const PAGE_SIZE = 10;
const MAX_PAGES = 30;
const DIP = "https://search.dip.bundestag.de/api/v1/plenarprotokoll";

export { RecordNotFoundError, type RecordSpeech };

export type Sitting = { xmlUrl: string; period: number; sitting: number; date: string };
type BundestagRef = Extract<RecordRef, { chamber: "bundestag" }>;

const GERMAN_STOP =
  ("und der die das den dem des ein eine einer einem einen eines nicht mit auf für ist sind war sich auch wir sie ich es zu von im in an am um aus bei nach vor über unter " +
    "als wie wenn dass daß aber oder nur noch schon mehr sehr hat haben wird werden wurde kann können muss müssen soll sollen so da dann doch hier heute " +
    "uns unser unsere unserer ihr ihre ihren ihrem ihrer er ihn ihm mir mich dir dich man was wer wo " +
    "herr frau präsident präsidentin vizepräsident vizepräsidentin kollegen kolleginnen kollege kollegin damen herren abgeordnete abgeordneten geehrte geehrter liebe lieben meine " +
    "bundesregierung bundestag").split(" ");
/** Both the spelling and the accent-stripped form: the aligner compares normalised tokens. */
const stopWords: ReadonlySet<string> = new Set(GERMAN_STOP.flatMap((w) => [w, normaliseName(w)]));

const MONTHS: Record<string, string> = {
  januar: "01", februar: "02", märz: "03", april: "04", mai: "05", juni: "06", juli: "07", august: "08", september: "09", oktober: "10", november: "11", dezember: "12",
};

const listingUrl = (period: number, offset: number) => `${AJAX}/${LIST_IDS[period]}?limit=${PAGE_SIZE}&offset=${offset}&noFilterSet=true`;

/** "Plenarprotokoll der 103. Sitzung von Freitag, dem 16. Oktober 2026" → sitting and ISO date; null when the title has another shape. */
function parseTitle(title: string): { sitting: number; date: string } | null {
  const m = /(\d+)\.\s*Sitzung\s+von\s+[^,]*,\s*dem\s+(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})/.exec(title);
  const month = m ? MONTHS[m[3]!.toLowerCase()] : undefined;
  if (!m || !month) return null;
  return { sitting: Number(m[1]), date: `${m[4]}-${month}-${m[2]!.padStart(2, "0")}` };
}

/** The sittings a list page links (each appears twice in the page; deduplicated, page order kept) and whether it is the "no results" page. */
function parseListing(html: string, period: number, url: string): { entries: Sitting[]; noResults: boolean } {
  const entries = new Map<string, Sitting>();
  for (const m of html.matchAll(/<a\s[^>]*href="(https:\/\/www\.bundestag\.de\/resource\/blob\/\d+\/[^"]+\.xml)"[^>]*>\s*<span>([^<]*)<\/span>/g)) {
    const t = parseTitle(m[2]!);
    if (!t) throw listingError(url, `the title "${m[2]!.trim()}" of ${m[1]} has an unknown shape (the page layout may have changed)`);
    if ( !entries.has(m[1]!)) entries.set(m[1]!, { xmlUrl: m[1]!, period, ...t });
  }
  return { entries: [...entries.values()], noResults: html.includes("e-noResults") };
}

/** A failed list request or an unreadable list page: transient, and the message names the list URL. */
const listingError = (url: string, why: string) => new Error(`The Bundestag open-data list ${url} could not be read: ${why}`);

async function fetchListing(period: number, offset: number, f: typeof fetch): Promise<{ entries: Sitting[]; noResults: boolean }> {
  const url = listingUrl(period, offset);
  let html: string;
  try {
    const res = await get(url, "text/html", f, "Bundestag");
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw listingError(url, err instanceof Error ? err.message : String(err));
  }
  const page = parseListing(html, period, url);
  if (offset === 0 && page.entries.length === 0 && page.noResults) throw listingError(url, "the list of a known period is empty (the list id may have changed)");
  if (page.entries.length === 0 && !page.noResults) throw listingError(url, "the page has no Plenarprotokoll links (the page layout may have changed)");
  return page;
}

type Located = { found: Sitting } | { missing: "newer" | "gap" | "unknown" };

/** Pages through the period's list (newest first) until it covers the ref. */
async function locateInListing(ref: BundestagRef, f: typeof fetch): Promise<Located> {
  if (!LIST_IDS[ref.period]) return { missing: "gap" };
  const covered = (s: Sitting) => (ref.sitting != null ? s.sitting <= ref.sitting : s.date <= (ref.date as string));
  for (let page = 0; page < MAX_PAGES; page++) {
    const { entries, noResults } = await fetchListing(ref.period, page * PAGE_SIZE, f);
    const hit = entries.find((s) => (ref.sitting != null ? s.sitting === ref.sitting : s.date === ref.date));
    if (hit) return { found: hit };
    if (page === 0 && entries[0] && (ref.sitting != null ? entries[0].sitting < ref.sitting : entries[0].date < (ref.date as string))) return { missing: "newer" };
    if (noResults || entries.some(covered)) return { missing: "gap" };
  }
  throw listingError(listingUrl(ref.period, 0), `${ref.sitting != null ? `sitting ${ref.sitting}` : ref.date} was not reached in ${MAX_PAGES} pages`);
}

const dipDoc = (d: unknown): Sitting | null => {
  const o = d as { dokumentnummer?: string; datum?: string; fundstelle?: { xml_url?: string } } | null;
  const m = /^(\d+)\/(\d+)$/.exec(o?.dokumentnummer ?? "");
  if (!m || !o?.fundstelle?.xml_url || !o.datum) return null;
  return { xmlUrl: o.fundstelle.xml_url, period: Number(m[1]), sitting: Number(m[2]), date: o.datum };
};

/** The DIP API (key required): the protocol by number ("21/103") or by day. A 404 or an empty answer means unknown, never an error. */
async function locateInDip(ref: BundestagRef, key: string, f: typeof fetch): Promise<Located> {
  const query = ref.sitting != null
    ? `f.dokumentnummer=${ref.period}/${ref.sitting}`
    : `f.datum_start=${ref.date}&f.datum_end=${ref.date}&f.wahlperiode=${ref.period}`;
  const res = await get(`${DIP}?${query}`, "application/json", f, "Bundestag DIP", { Authorization: `ApiKey ${key}` });
  if (res.status === 401 || res.status === 403) throw new ApiKeyRejectedError("BUNDESTAG_DIP_API_KEY");
  if (res.status === 404) return { missing: "unknown" };
  if (!res.ok) throw new Error(`The Bundestag DIP API answered ${res.status}.`);
  const body = (await res.json()) as { documents?: unknown[] };
  const docs = body.documents ?? [];
  const parsedDocs = docs.map(dipDoc);
  if (docs.length > 0 && parsedDocs.every((d) => d === null)) throw new Error("The Bundestag DIP API answered documents without dokumentnummer, datum or fundstelle.xml_url (the answer shape may have changed).");
  const hit = parsedDocs.find((s) => s && s.period === ref.period && (ref.sitting != null ? s.sitting === ref.sitting : s.date === ref.date));
  return hit ? { found: hit } : { missing: "unknown" };
}

async function locate(ref: BundestagRef, f: typeof fetch): Promise<Located> {
  try {
    return await locateInListing(ref, f);
  } catch (err) {
    const key = process.env.BUNDESTAG_DIP_API_KEY;
    if (!key || err instanceof RecordNotFoundError) throw err;
    console.warn(`[bundestag] ${(err as Error).message}; trying the DIP API`);
    try {
      return await locateInDip(ref, key, f);
    } catch (dipErr) {
      if (dipErr instanceof ApiKeyRejectedError) throw dipErr;
      throw new Error(`${(err as Error).message} (the DIP fallback failed too: ${(dipErr as Error).message})`);
    }
  }
}

// ---- the protocol XML ------------------------------------------------------

type XNode = { [tag: string]: unknown } & { ":@"?: Record<string, string> };
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: false, processEntities: true, htmlEntities: true, parseTagValue: false });

const tagOf = (n: XNode): string => Object.keys(n).find((k) => k !== ":@") ?? "";
const childrenOf = (n: XNode): XNode[] => (n[tagOf(n)] as XNode[] | undefined) ?? [];
const attrOf = (n: XNode, name: string): string | undefined => n[":@"]?.[`@_${name}`];

/** All text of a node, without `<kommentar>` and page-number markers. */
function textOf(nodes: XNode[]): string {
  let out = "";
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === "#text") out += String(n["#text"] ?? "");
    else if (tag === "kommentar" || (tag === "a" && attrOf(n, "typ") === "druckseitennummer")) continue;
    else out += textOf(childrenOf(n));
  }
  return out;
}
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const find = (nodes: XNode[], tag: string): XNode | undefined => nodes.find((n) => tagOf(n) === tag);
const textIn = (nodes: XNode[], tag: string): string => {
  const n = find(nodes, tag);
  return n ? clean(textOf(childrenOf(n))) : "";
};
const BODY_CLASSES = new Set(["J", "J_1", "O"]);
const CHAIR_UNKNOWN = "Sitzungsleitung";

const isoDate = (ddmmyyyy: string | undefined): string | null => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ddmmyyyy ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/**
 * Parses a Plenarprotokoll. Speeches come in document order; each turn of a speaker is its own speech, so the
 * president's lines (a bare `<name>` with no id) inside a `<rede>` never join the surrounding speaker's text, and a speaker
 * who is interrupted and continues gets a second speech. Ministers carry an id and no party.
 */
export function parseProtokoll(xml: string): { date: string; period: number; sitting: number; speeches: RecordSpeech[]; members: Record<string, MemberInfo> } {
  const tree = parser.parse(xml) as XNode[];
  const root = tree.find((n) => tagOf(n) === "dbtplenarprotokoll");
  const date = root ? isoDate(attrOf(root, "sitzung-datum")) : null;
  const period = Number(root ? attrOf(root, "wahlperiode") : NaN);
  const sitting = Number(root ? attrOf(root, "sitzung-nr") : NaN);
  const verlauf = root ? find(childrenOf(root), "sitzungsverlauf") : undefined;
  if (!root || !verlauf || !date || !Number.isInteger(period) || !Number.isInteger(sitting)) throw new Error("The XML is not a Bundestag Plenarprotokoll (no root attributes or no sitzungsverlauf).");

  const speeches: RecordSpeech[] = [];
  const members: Record<string, MemberInfo> = {};
  type Turn = { officialId: string | null; name: string; party: string | null; parts: string[] };
  let turn: Turn | null = null;
  const flush = () => {
    if (turn) {
      const text = clean(turn.parts.join(" "));
      if (text) speeches.push({ id: `${period}-${sitting}-${speeches.length + 1}`, order: speeches.length + 1, officialId: turn.officialId, name: turn.name, party: turn.party, state: null, text, textSource: "full" });
    }
    turn = null;
  };
  const startChair = (name: string) => { flush(); turn = { officialId: null, name, party: null, parts: [] }; };

  const walk = (nodes: XNode[]) => {
    for (const n of nodes) {
      const tag = tagOf(n);
      if (tag === "rede") { flush(); walk(childrenOf(n)); flush(); continue; }
      if (tag === "name") { startChair(clean(textOf(childrenOf(n))).replace(/:$/, "")); continue; }
      if (tag === "p") {
        const klasse = attrOf(n, "klasse");
        const kids = childrenOf(n);
        if (klasse === "redner") {
          const r = find(kids, "redner");
          const id = r ? attrOf(r, "id") : undefined;
          const nm = r ? find(childrenOf(r), "name") : undefined;
          if (!r || !id || !nm) { startChair(CHAIR_UNKNOWN); continue; }
          const parts = childrenOf(nm);
          const fullName = clean([textIn(parts, "titel"), textIn(parts, "vorname"), textIn(parts, "namenszusatz"), textIn(parts, "nachname")].filter(Boolean).join(" "));
          const party = textIn(parts, "fraktion") || null;
          flush();
          turn = { officialId: id, name: fullName, party, parts: [] };
          members[id] ??= { displayName: fullName, fullName, party, state: null };
        } else if (klasse && BODY_CLASSES.has(klasse)) {
          if (!turn) turn = { officialId: null, name: CHAIR_UNKNOWN, party: null, parts: [] };
          (turn as Turn).parts.push(textOf(kids));
        }
        continue;
      }
      // sitzungsbeginn, tagesordnungspunkt and the like: the chair's turn carries over from the opening to the agenda items
      if (tag === "sitzungsbeginn" || tag === "tagesordnungspunkt" || tag === "sitzungsende") walk(childrenOf(n));
    }
  };
  walk(childrenOf(verlauf));
  flush();
  return { date, period, sitting, speeches, members };
}

// ---- the connector ----------------------------------------------------------

async function findSitting(ref: BundestagRef, f: typeof fetch): Promise<Sitting | null> {
  const r = await locate(ref, f);
  return "found" in r ? r.found : null;
}

async function fetchRecord(ref: RecordRef, f: typeof fetch, ctx: { now: Date; linkedAt: Date }) {
  if (ref.chamber !== "bundestag") throw new RecordNotFoundError("The Bundestag connector got a ref of another house.");
  const located = await locate(ref, f);
  if (!("found" in located)) {
    if (ref.sitting != null) {
      if (located.missing === "gap") throw new RecordNotFoundError("The Bundestag has no record for that sitting.");
      throw notPublishedOrNotFound("bundestag", null, ctx.now, "The Bundestag has no record for that sitting.", ctx.linkedAt);
    }
    throw notPublishedOrNotFound("bundestag", ref.date, ctx.now, "The Bundestag has no record for that date.", ctx.linkedAt);
  }
  const { xmlUrl } = located.found;
  let parsed: ReturnType<typeof parseProtokoll>;
  try {
    const res = await get(xmlUrl, "application/xml", f, "Bundestag");
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    parsed = parseProtokoll(await res.text());
  } catch (err) {
    throw new Error(`The Bundestag protocol ${xmlUrl} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const want = located.found;
  if (parsed.period !== want.period || parsed.sitting !== want.sitting || (ref.date != null && parsed.date !== ref.date) || (ref.sitting != null && parsed.sitting !== ref.sitting)) {
    throw new RecordNotFoundError("The Bundestag protocol doesn't match the sitting asked for.");
  }
  return { speeches: parsed.speeches, date: parsed.date, url: xmlUrl, members: parsed.members };
}

export const bundestagConnector: RecordConnector & { findSitting: typeof findSitting } = {
  chamber: "bundestag",
  fetchRecord,
  findSitting,
  speechText: (s) => s.text,
  stopWords,
};
