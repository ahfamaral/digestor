import { XMLParser } from "fast-xml-parser";
import type { RecordRef } from "@digestor/core";
import { ApiKeyRejectedError, MissingApiKeyError } from "../errors.js";
import type { MemberInfo, RecordConnector, RecordSpeech } from "./types.js";
import { RecordNotFoundError, notPublishedOrNotFound } from "./types.js";
import { get, mapLimit } from "./http.js";

/**
 * US House and Senate: the Congressional Record on GovInfo (https://api.govinfo.gov, key `API_DATA_GOV_KEY`). Shapes recorded
 * 2026-11-04, see `fakeUsCongress.ts` and test/fixtures/crec-*.
 *  - One package per day, `CREC-YYYY-MM-DD`, with House, Senate, Extensions and Daily Digest granules told apart by
 *    `granuleClass`. A package that doesn't exist answers 200 with no granules (a 404 is treated the same).
 *  - A granule is a debate item, not a speech. Its `htm` is a `<pre>`: a speech starts on a line that begins with two spaces
 *    and a label ("  Mr. NADLER. Mr. Speaker, ..."); `[[Page H2791]]`, `{time} 1315` and centred headings sit between.
 *  - Its `mods` lists the granule's speakers as `congMember` (bioGuideId, party, state) with a `parsed` name that equals the
 *    label ("Mr. NADLER", "Mr. SMITH of New Jersey"). The chair ("The SPEAKER pro tempore", "The PRESIDING OFFICER", "The
 *    CLERK") is not a congMember: those speeches carry `officialId: null`, and so does every label that doesn't map to
 *    exactly one member (never a wrong name).
 *  - Package-level MODS (`/packages/CREC-…/mods`) was not tried: its congMembers would mix granules and make two members of
 *    one surname ambiguous across a day, so MODS is read per granule, and only for granules whose text has a label.
 */
const BASE = "https://api.govinfo.gov/packages";

const stopWords: ReadonlySet<string> = new Set(
  ("the and that this with have for are was were not you your our from they their there which would will been has had speaker madam president gentleman gentlewoman yield time chair " +
    "a an of to in is it as at be by on or we he she his her its but if so do does did can could should may might must than then them these those who whom what when where while about into over also more most other some such only very " +
    "mr ms mrs miss dr gentlemen gentlewomen colleagues colleague distinguished honorable senator representative congressman congresswoman senate house bill resolution reserve balance remainder rise rising urge thank thanks recognize recognized today").split(" "),
);

type UsRef = Extract<RecordRef, { chamber: "us_house" | "us_senate" }>;
type Granule = { granuleClass?: string; granuleId?: string };

// ---- the htm ---------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") return String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** A surname word: "NADLER", "McCLINTOCK", "DesJARLAIS", "O'ROURKE". Not "Speaker". */
const WORD = "(?:[A-Z][a-z]{0,3}[A-Z][A-Za-z'’-]*|[A-Z][A-Z'’-]+)";
const PERSON = new RegExp(`^  ((?:Mr|Ms|Mrs|Miss|Dr)\\. ${WORD}(?: ${WORD})*(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*)?)\\.(?: |$)`);
/** "The SPEAKER pro tempore.", "The PRESIDING OFFICER (Mr. LEE).", "The CLERK.", "The ACTING PRESIDENT pro tempore." */
const CHAIR = /^  (The (?:Acting )?[A-Z]{2,}(?: [A-Z]{2,})*(?: pro tempore)?)(?: \([^)]*\))?\.(?: |$)/;

const isNoise = (line: string) =>
  /^\s*\[\[Page [A-Z]*\d+\]\]\s*$/.test(line) || /^\s*\{time\}\s*\d*\s*$/.test(line) || /^\s*_{5,}\s*$/.test(line) || /^ {20,}\S/.test(line);

type Raw = { label: string; person: boolean; parts: string[] };

function labelledBlocks(htm: string): Raw[] {
  const pre = /<pre>([\s\S]*?)<\/pre>/i.exec(htm)?.[1] ?? "";
  const lines = decode(pre.replace(/<[^>]+>/g, "")).split("\n");
  const start = lines.findIndex((l) => l.startsWith("From the Congressional Record Online"));
  const out: Raw[] = [];
  let cur: Raw | null = null;
  for (const line of lines.slice(start + 1)) {
    if (isNoise(line)) continue;
    const p = PERSON.exec(line);
    const c = p ? null : CHAIR.exec(line);
    const m = p ?? c;
    if (m) {
      cur = { label: m[1]!, person: !!p, parts: [line.slice(m[0].length)] };
      out.push(cur);
    } else if (cur) cur.parts.push(line);
  }
  return out;
}

// ---- the MODS --------------------------------------------------------------

type Member = { id: string; parsed: string[]; fnf: string | null; party: string | null; state: string | null };
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, parseAttributeValue: false, trimValues: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function findAll(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(...arr(v));
    else findAll(v, key, out);
  }
  return out;
}

function membersOf(mods: string): Member[] {
  let tree: unknown;
  try {
    tree = xml.parse(mods);
  } catch {
    return [];
  }
  const out: Member[] = [];
  for (const m of findAll(tree, "congMember") as Record<string, unknown>[]) {
    const id = m["@_bioGuideId"];
    if (typeof id !== "string" || !id) continue;
    const names = arr(m["name"] as unknown).map((n) => (typeof n === "object" && n ? { type: (n as Record<string, unknown>)["@_type"], text: (n as Record<string, unknown>)["#text"] } : null));
    const named = (type: string) => names.filter((n) => n?.type === type && typeof n.text === "string").map((n) => squash(n!.text as string));
    out.push({
      id,
      parsed: named("parsed"),
      fnf: named("authority-fnf")[0] ?? null,
      party: (m["@_party"] as string | undefined) || null,
      state: (m["@_state"] as string | undefined) || null,
    });
  }
  return out;
}

/** The one member a label stands for: a `parsed` name equal to the label, verbatim (case-sensitive, so a narrative "Mr. McClintock." is no label). None or more than one: null, never a guess. */
function resolve(label: string, members: Member[]): Member | null {
  const l = squash(label);
  const hits = members.filter((m) => m.parsed.includes(l));
  return new Set(hits.map((h) => h.id)).size === 1 ? hits[0]! : null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The granule's speeches in text order, plus what its MODS says about the members who spoke. */
export function parseGranuleMembers(htm: string, mods: string): { speeches: RecordSpeech[]; members: Record<string, MemberInfo> } {
  const members = membersOf(mods);
  const info: Record<string, MemberInfo> = {};
  const speeches: RecordSpeech[] = [];
  for (const b of labelledBlocks(htm)) {
    const text = clean(b.parts.join(" "));
    if (!text) continue;
    const m = b.person ? resolve(b.label, members) : null;
    if (m) info[m.id] ??= { displayName: m.fnf ?? b.label, fullName: m.fnf, party: m.party, state: m.state };
    speeches.push({ id: String(speeches.length + 1), order: speeches.length + 1, officialId: m?.id ?? null, name: m ? (m.fnf ?? b.label) : b.label, party: m?.party ?? null, state: m?.state ?? null, text, textSource: "full" });
  }
  return { speeches, members: info };
}

export const parseGranule = (htm: string, mods: string): RecordSpeech[] => parseGranuleMembers(htm, mods).speeches;

// ---- the connector ---------------------------------------------------------

/** Only a person's label (not the chair, the clerk) needs the MODS to be named: chair-only granules skip that request. */
const hasPerson = (htm: string) => labelledBlocks(htm).some((b) => b.person);
/** Page of `CREC-2026-01-05-pt1-PgH2790-2` (2790); front matter has none and comes first. */
const pageOf = (id: string) => { const m = /Pg[HS](\d+)/.exec(id); return m ? Number(m[1]) : -1; };
/** The `-N` suffix of a sub-granule on the same page (the page's own granule has none and is first). */
const subOf = (id: string) => { const m = /-(\d+)$/.exec(id.replace(/^CREC-\d{4}-\d{2}-\d{2}-pt\d+-/, "")); return m ? Number(m[1]) : 1; };

const MAX_LIST_PAGES = 20;
const keyHeader = (key: string) => ({ "x-api-key": key });

/** GET with the key in `X-Api-Key`; 403/401 means the key was refused (deterministic). */
async function govGet(url: string, accept: string, key: string, f: typeof fetch): Promise<Response> {
  const res = await get(url, accept, f, "GovInfo", keyHeader(key));
  if (res.status === 403 || res.status === 401) throw new ApiKeyRejectedError("API_DATA_GOV_KEY");
  return res;
}

async function listGranules(date: string, key: string, f: typeof fetch): Promise<Granule[] | null> {
  const out: Granule[] = [];
  let url: string | null = `${BASE}/CREC-${date}/granules?pageSize=1000&offsetMark=*`;
  for (let page = 0; url && page < MAX_LIST_PAGES; page++) {
    const res = await govGet(url, "application/json", key, f);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`The GovInfo API answered ${res.status}.`);
    const body = (await res.json()) as { granules?: Granule[]; nextPage?: string | null };
    out.push(...(body.granules ?? []));
    url = body.nextPage || null;
  }
  if (url) throw new Error(`The GovInfo granule list of ${date} has more than ${MAX_LIST_PAGES} pages; refusing to read a truncated record.`);
  return out;
}

async function text(url: string, accept: string, key: string, f: typeof fetch): Promise<string> {
  const res = await govGet(url, accept, key, f);
  if (!res.ok) throw new Error(`The GovInfo API answered ${res.status} for ${url}.`);
  return res.text();
}

function connector(chamber: "us_house" | "us_senate", granuleClass: "HOUSE" | "SENATE", name: "House" | "Senate"): RecordConnector {
  const notFound = `The ${name} has no record for that date.`;
  return {
    chamber,
    stopWords,
    speechText: (s) => s.text,
    async fetchRecord(ref, f, ctx) {
      if (ref.chamber !== chamber) throw new RecordNotFoundError(`The ${name} connector got a ref of another house.`);
      const { date } = ref as UsRef;
      const key = process.env.API_DATA_GOV_KEY;
      if (!key) throw new MissingApiKeyError("API_DATA_GOV_KEY");
      const all = await listGranules(date, key, f);
      // Nothing there: not out yet (the daily edition appears the next morning) or no such day.
      if (!all || all.length === 0) throw notPublishedOrNotFound(chamber, date, ctx.now, notFound, ctx.linkedAt);
      const mine = all
        .map((g, i) => ({ id: g.granuleId ?? "", cls: g.granuleClass, i }))
        .filter((g) => g.cls === granuleClass && g.id)
        .sort((a, b) => pageOf(a.id) - pageOf(b.id) || subOf(a.id) - subOf(b.id) || a.i - b.i);
      if (mine.length === 0) throw new RecordNotFoundError(notFound);
      const parsed = await mapLimit(mine, 4, async (g) => {
        const base = `${BASE}/CREC-${date}/granules/${g.id}`;
        const htm = await text(`${base}/htm`, "text/html", key, f);
        const mods = hasPerson(htm) ? await text(`${base}/mods`, "application/xml", key, f) : "<mods/>";
        return { id: g.id, ...parseGranuleMembers(htm, mods) };
      });
      const speeches: RecordSpeech[] = [];
      const members: Record<string, MemberInfo> = {};
      for (const p of parsed) {
        for (const s of p.speeches) speeches.push({ ...s, id: `${p.id}-${s.id}`, order: speeches.length + 1 });
        Object.assign(members, p.members);
      }
      return { speeches, date, members };
    },
  };
}

export const usHouseConnector = connector("us_house", "HOUSE", "House");
export const usSenateConnector = connector("us_senate", "SENATE", "Senate");
