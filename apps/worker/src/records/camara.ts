import { z } from "zod";
import { getJson, mapLimit } from "./http.js";
import { RecordNotFoundError, notPublishedOrNotFound, type MemberInfo, type RecordConnector, type RecordSpeech } from "./types.js";
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
export const CAMARA_NO_PLENARY = "The Câmara has no plenary session on that date.";
export const CAMARA_CANCELLED = "This Câmara session was cancelled or never confirmed.";
export const CAMARA_NOT_COMPLETE = "The Câmara record of this session isn't complete yet. Try again later.";
export const CAMARA_DAY_NOT_COMPLETE = "The Câmara record of that date isn't complete yet. Try again later.";

/** The event date (`YYYY-MM-DD`) of an event's "not complete yet" error, so the connector counts the publish window from it (kept off the error itself: it stays a plain `RecordNotFoundError`). */
const eventDateOf = new WeakMap<Error, string>();
function notComplete(eventDate: string): RecordNotFoundError {
  const err = new RecordNotFoundError(CAMARA_NOT_COMPLETE);
  eventDateOf.set(err, eventDate);
  return err;
}

/** The Plenário is the only organ read. */
const isPlenary = (orgaos: { sigla: string | null }[] | null | undefined) => !!orgaos?.some((o) => o.sigla === "PLEN");
/** What an event's `situacao` says about its record: never happening, not over yet, or over. */
const situacaoVerdict = (s: string | null | undefined): "cancelled" | "incomplete" | "ended" =>
  s?.startsWith("Cancelada") || s === "Não Confirmada" ? "cancelled" : s?.startsWith("Encerrada") ? "ended" : "incomplete";

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
  if (!isPlenary(orgaos)) throw new RecordNotFoundError(CAMARA_NOT_PLENARY);
  const verdict = situacaoVerdict(situacao);
  if (verdict === "cancelled") throw new RecordNotFoundError(CAMARA_CANCELLED);
  if (verdict === "incomplete") throw notComplete(event.data.dados.dataHoraInicio.slice(0, 10));
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

const dayListSchema = z.object({
  dados: z.array(z.object({ id: str, situacao: str, orgaos: z.array(z.object({ sigla: str }).passthrough()).nullish() }).passthrough()),
}).passthrough();
/** The Plenário's organ id: `eventos?idOrgao=180` keeps its events (`codTipoEvento`/`siglaOrgao` don't; recorded 2026-11-04). */
const PLEN_ORGAO_ID = 180;

/**
 * The speeches of every plenary event of one day (`YYYY-MM-DD`): the day's Plenário events are listed (filtered by
 * `idOrgao` on the server and by `orgaos[].sigla === "PLEN"` again here), cancelled ones are skipped, and if any other
 * one hasn't ended the day isn't complete (nothing is swept). Each event is read by `fetchCamaraSpeeches` (the window,
 * PLEN and situacao rules live there); a plenary with no speech of its own is skipped. Speeches are merged in stamp
 * order and renumbered, the deputies of all events merged. No plenary: `RecordNotFoundError`.
 */
export async function fetchCamaraDay(
  date: string,
  f: typeof fetch = fetch,
): Promise<{ speeches: RecordSpeech[]; date: string; deputies: Record<string, CamaraDeputy> }> {
  const list = await getAllPages(`${BASE}/eventos?dataInicio=${date}&dataFim=${date}&itens=100&idOrgao=${PLEN_ORGAO_ID}`, f, (body) => {
    const parsed = dayListSchema.safeParse(body);
    if (!parsed.success) throw unexpected();
    return parsed.data.dados;
  });
  const plenaries = (list ?? []).filter((e) => e.id != null && isPlenary(e.orgaos));
  if (plenaries.length === 0) throw new RecordNotFoundError(CAMARA_NO_PLENARY);
  const live = plenaries.filter((e) => situacaoVerdict(e.situacao) !== "cancelled");
  if (live.length === 0) throw new RecordNotFoundError(CAMARA_CANCELLED);
  if (live.some((e) => situacaoVerdict(e.situacao) !== "ended")) throw new RecordNotFoundError(CAMARA_NOT_COMPLETE);

  // Events of one day share their deputies' day: each `deputados/{id}/discursos` page is fetched once (successful answers only; events run one after the other).
  const memo = new Map<string, { status: number; headers: [string, string][]; text: string }>();
  const memoFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!/\/deputados\/[^/]+\/discursos/.test(url)) return f(input, init);
    let hit = memo.get(url);
    if (!hit) {
      const res = await f(input, init);
      if (res.status !== 200) return res;
      hit = { status: res.status, headers: [...res.headers.entries()], text: await res.text() };
      memo.set(url, hit);
    }
    return new Response(hit.text, { status: hit.status, headers: hit.headers });
  }) as typeof fetch;

  const deputies: Record<string, CamaraDeputy> = {};
  const byId = new Map<string, RecordSpeech>();
  for (const e of live) {
    let got: Awaited<ReturnType<typeof fetchCamaraSpeeches>>;
    try {
      got = await fetchCamaraSpeeches(e.id!, memoFetch);
    } catch (err) {
      if (err instanceof RecordNotFoundError && err.message === CAMARA_NOT_FOUND) continue; // ended, but nobody spoke in its window
      throw err;
    }
    for (const [id, d] of Object.entries(got.deputies)) deputies[id] ??= d;
    for (const sp of got.speeches) byId.set(sp.id, sp);
  }
  if (byId.size === 0) throw new RecordNotFoundError(CAMARA_NOT_FOUND);
  const speeches = [...byId.values()]
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || Number(a.officialId) - Number(b.officialId) || a.id.localeCompare(b.id))
    .map((sp, i) => ({ ...sp, order: i + 1 }));
  return { speeches, date, deputies };
}

/** The Câmara behind the connector interface: an event's speeches (or a day's), the deputies as `members`. */
export const camaraConnector: RecordConnector = {
  chamber: "camara",
  async fetchRecord(ref, f, ctx) {
    if (ref.chamber !== "camara") throw new RecordNotFoundError("The Câmara connector got a ref of another house.");
    let got: Awaited<ReturnType<typeof fetchCamaraSpeeches>>;
    try {
      got = "eventId" in ref ? await fetchCamaraSpeeches(ref.eventId, f) : await fetchCamaraDay(ref.date, f);
    } catch (err) {
      if (!(err instanceof RecordNotFoundError)) throw err;
      // An event link carries no date: its own date comes with the error (the window counts from it), else from the link.
      const date = "date" in ref ? ref.date : eventDateOf.get(err) ?? null;
      // Recent: an unfinished record or a day with no plenary/speeches yet may still be published. A cancelled session is never.
      if (err.message === CAMARA_NOT_COMPLETE) {
        throw notPublishedOrNotFound("camara", date, ctx.now, "date" in ref ? CAMARA_DAY_NOT_COMPLETE : CAMARA_NOT_COMPLETE, ctx.linkedAt);
      }
      if ("date" in ref && (err.message === CAMARA_NO_PLENARY || err.message === CAMARA_NOT_FOUND)) throw notPublishedOrNotFound("camara", date, ctx.now, err.message, ctx.linkedAt);
      throw err;
    }
    const { speeches, date, deputies } = got;
    const members: Record<string, MemberInfo> = {};
    for (const [id, d] of Object.entries(deputies)) members[id] = { displayName: d.name, party: d.party, state: d.state, photoUrl: d.photoUrl };
    return { speeches, date, members };
  },
  speechText: (s) => speechText(s.text),
  stopWords: STOP,
};
