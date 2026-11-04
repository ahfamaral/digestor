import { z } from "zod";
import { getJson, mapLimit } from "./http.js";
import { RecordNotFoundError, type MemberInfo, type RecordConnector, type RecordSpeech } from "./connector.js";
import { speechText, STOP } from "./align.js";

/**
 * Câmara dos Deputados open-data client (https://dadosabertos.camara.leg.br/api/v2). Shapes recorded 2026-11-03 on
 * event 82635 (the plenary of 2026-06-30), see test/fixtures/camara-*.json. Every answer is `{ dados, links }`
 * (Accept: application/json, no key). Three calls:
 *  - GET eventos/{id}: `dataHoraInicio` / `dataHoraFim` ("2026-06-30T13:55", Brasília time without zone; the end can be
 *    null). An unknown id answers 404;
 *  - GET eventos/{id}/deputados: the event's deputies (id, nome, siglaPartido, siglaUf, urlFoto); 494 on that plenary;
 *  - GET deputados/{id}/discursos?dataInicio&dataFim&itens=100: the deputy's speeches in those days (`dataHoraInicio`, a 4-minute block, to
 *    the minute, `transcricao` full text starting "O SR. NAME (PL - DF. Pela ordem. ...) - ", `sumario`, `uriEvento`
 *    EMPTY: a speech doesn't say which event it belongs to). GET eventos/{id}/discursos answers 405: there is no per-event list.
 * So the session's list is built: the event's window on its date, plus every event deputy's speeches of that day whose
 * start falls inside it (~500 calls, 4 at a time, under 3 min on the plenary). Order is by stamp, then deputy id:
 * A stamp is a 4-minute stenography block (every spoken speech of the probe sits on a minute divisible by 4; only
 * texts handed to the Mesa use the session's exact start minute), so the start is floored to its block and several
 * speeches often share a stamp. Their true order is unknown: this list orders them by deputy id, and the pipeline
 * reorders each run of equal stamps by best-matching turn before the monotonic alignment (`tieOrder` in align.ts).
 * Only plenary events (`orgaos` has PLEN) that have ended (`situacao` "Encerrada...") are accepted.
 * Lists follow the `links` entry `rel: "next"` when the API gives one (not seen live: the probe never needed it at
 * `itens=100`). A deputy's `/discursos` answering 404 (not seen live either) is logged and skipped, not a failure.
 */
const BASE = "https://dadosabertos.camara.leg.br/api/v2";
const CONCURRENCY = 4;
const LABEL = "Câmara";

export const CAMARA_NOT_FOUND = "The Câmara has no speeches for that session.";
export const CAMARA_NOT_PLENARY = "Only Câmara plenary sessions are supported.";
export const CAMARA_CANCELLED = "This Câmara session was cancelled or never confirmed.";
export const CAMARA_NOT_COMPLETE = "The Câmara record of this session isn't complete yet. Try again later.";

/** The 4-minute stenography block a stamp belongs to: `2026-06-30T13:55` → `2026-06-30T13:52`. */
function blockStart(stamp: string): string {
  const minute = Number(stamp.slice(14, 16));
  return `${stamp.slice(0, 14)}${String(minute - (minute % 4)).padStart(2, "0")}`;
}

const str = z.union([z.string(), z.number()]).transform(String).nullish().transform((v) => (v == null || v === "" ? null : v));
const linksSchema = z.object({ links: z.array(z.object({ rel: str, href: str }).passthrough()).nullish() }).passthrough();
const eventSchema = z.object({
  dados: z.object({
    dataHoraInicio: z.string().min(10),
    dataHoraFim: str,
    situacao: str,
    orgaos: z.array(z.object({ sigla: str }).passthrough()).nullish(),
  }).passthrough(),
}).passthrough();
const deputiesSchema = z.object({
  dados: z.array(z.object({ id: str, nome: str, siglaPartido: str, siglaUf: str, urlFoto: str }).passthrough()),
}).passthrough();
const speechesSchema = z.object({
  dados: z.array(z.object({ dataHoraInicio: str, transcricao: str, sumario: str }).passthrough()),
}).passthrough();

export interface CamaraDeputy {
  name: string;
  party: string | null;
  state: string | null;
  photoUrl: string | null;
}

const unexpected = () => new Error("The Câmara API answered with an unexpected shape.");
const MAX_PAGES = 50;

/** Every page of a list: `parse` reads one answer's `dados`; the next page is the `links` entry with `rel: "next"`. 404 on the first page is `null`. */
async function getAllPages<T>(url: string, f: typeof fetch, parse: (body: unknown) => T[]): Promise<T[] | null> {
  const out: T[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res = await getJson(next, f, LABEL);
    if (res.status === 404) {
      if (page === 0) return null;
      break;
    }
    out.push(...parse(res.body));
    next = linksSchema.safeParse(res.body).data?.links?.find((l) => l.rel === "next")?.href ?? null;
  }
  return out;
}

/**
 * The speeches of a Câmara event (see the header for how they are found), the event's date (`YYYY-MM-DD`) and the
 * event's deputies by id (the person fields come from here: one call, not one per deputy). A 404 on the event or no
 * speech in its window throws `RecordNotFoundError`; a deputy call that keeps failing (after one retry) throws a plain
 * error, so the job retries rather than naming from a partial list.
 */
export async function fetchCamaraSpeeches(
  eventId: string,
  f: typeof fetch = fetch,
): Promise<{ speeches: RecordSpeech[]; date: string; deputies: Record<string, CamaraDeputy> }> {
  const ev = await getJson(`${BASE}/eventos/${encodeURIComponent(eventId)}`, f, LABEL);
  if (ev.status === 404) throw new RecordNotFoundError(CAMARA_NOT_FOUND);
  const event = eventSchema.safeParse(ev.body);
  if (!event.success) throw unexpected();
  const { orgaos, situacao } = event.data.dados;
  if (!orgaos?.some((o) => o.sigla === "PLEN")) throw new RecordNotFoundError(CAMARA_NOT_PLENARY);
  if (situacao?.startsWith("Cancelada") || situacao === "Não Confirmada") throw new RecordNotFoundError(CAMARA_CANCELLED);
  if (!situacao?.startsWith("Encerrada")) throw new RecordNotFoundError(CAMARA_NOT_COMPLETE);
  const eventStart = event.data.dados.dataHoraInicio.slice(0, 16);
  const start = blockStart(eventStart); // stamps are 4-minute blocks: the block holding the start belongs to the event
  const date = eventStart.slice(0, 10);
  const end = event.data.dados.dataHoraFim?.slice(0, 16) ?? `${date}T23:59`;
  const endDate = end.slice(0, 10);

  const list = await getAllPages(`${BASE}/eventos/${encodeURIComponent(eventId)}/deputados`, f, (body) => {
    const parsed = deputiesSchema.safeParse(body);
    if (!parsed.success) throw unexpected();
    return parsed.data.dados;
  });
  if (!list) throw new RecordNotFoundError(CAMARA_NOT_FOUND);
  const deputies: Record<string, CamaraDeputy> = {};
  for (const d of list) {
    if (d.id == null || d.nome == null || deputies[d.id]) continue;
    deputies[d.id] = { name: d.nome, party: d.siglaPartido, state: d.siglaUf, photoUrl: d.urlFoto };
  }
  const ids = Object.keys(deputies);

  const perDeputy = await mapLimit(ids, CONCURRENCY, async (id) => {
    const all = await getAllPages(`${BASE}/deputados/${id}/discursos?dataInicio=${date}&dataFim=${endDate}&itens=100`, f, (body) => {
      const parsed = speechesSchema.safeParse(body);
      if (!parsed.success) throw unexpected();
      return parsed.data.dados;
    });
    if (!all) {
      console.warn(`camara: deputy ${id} has no speeches page (404) for event ${eventId}; skipping`);
      return [];
    }
    // Ids must not shift when a speech is added later the same day: number within a minute after a stable sort.
    const sorted = all
      .map((s) => ({ at: s.dataHoraInicio?.slice(0, 16), full: s.transcricao?.trim(), summary: s.sumario?.trim() }))
      .filter((s): s is typeof s & { at: string } => !!s.at)
      .sort((x, y) => x.at.localeCompare(y.at) || (x.full ?? x.summary ?? "").length - (y.full ?? y.summary ?? "").length || (x.full ?? x.summary ?? "").localeCompare(y.full ?? y.summary ?? ""));
    const seen = new Map<string, number>();
    return sorted.flatMap((s) => {
      const n = seen.get(s.at) ?? 0;
      seen.set(s.at, n + 1);
      if (s.at < start || s.at > end) return [];
      const text = s.full || s.summary;
      if (!text) return [];
      return [{ id, at: s.at, n, text, textSource: s.full ? ("full" as const) : ("summary" as const) }];
    });
  });

  const picked = perDeputy.flat().sort((a, b) => a.at.localeCompare(b.at) || Number(a.id) - Number(b.id) || a.n - b.n);
  if (picked.length === 0) throw new RecordNotFoundError(CAMARA_NOT_FOUND);
  const speeches = picked.map((p, i): RecordSpeech => ({
    id: `${p.id}-${p.at}-${p.n}`,
    at: p.at,
    order: i + 1,
    officialId: p.id,
    name: deputies[p.id]!.name,
    party: deputies[p.id]!.party,
    state: deputies[p.id]!.state,
    text: p.text,
    textSource: p.textSource,
  }));
  return { speeches, date, deputies };
}

/** The Câmara behind the connector interface: an event's speeches, its deputies as `members`. A day ref (no event id) is not readable yet. */
export const camaraConnector: RecordConnector = {
  chamber: "camara",
  async fetchRecord(ref, f) {
    if (ref.chamber !== "camara" || !("eventId" in ref)) throw new RecordNotFoundError("The Câmara record can't be read yet.");
    const { speeches, date, deputies } = await fetchCamaraSpeeches(ref.eventId, f);
    const members: Record<string, MemberInfo> = {};
    for (const [id, d] of Object.entries(deputies)) members[id] = { displayName: d.name, party: d.party, state: d.state, photoUrl: d.photoUrl };
    return { speeches, date, members };
  },
  speechText: (s) => speechText(s.text),
  stopWords: STOP,
};
