import { z } from "zod";
import { getJson, mapLimit } from "./http.js";
import { RecordNotFoundError, type RecordSpeech } from "./senado.js";

/**
 * Câmara dos Deputados open-data client (https://dadosabertos.camara.leg.br/api/v2). Shapes recorded 2026-11-03 on
 * event 82635 (the plenary of 2026-06-30), see test/fixtures/camara-*.json. Every answer is `{ dados, links }`
 * (Accept: application/json, no key). Three calls:
 *  - GET eventos/{id}: `dataHoraInicio` / `dataHoraFim` ("2026-06-30T13:55", Brasília time without zone; the end can be
 *    null). An unknown id answers 404;
 *  - GET eventos/{id}/deputados: the event's deputies (id, nome, siglaPartido, siglaUf, urlFoto); 494 on that plenary;
 *  - GET deputados/{id}/discursos?dataInicio&dataFim&itens=100: the deputy's speeches in those days (`dataHoraInicio` to
 *    the minute, `transcricao` full text starting "O SR. NAME (PL - DF. Pela ordem. ...) - ", `sumario`, `uriEvento`
 *    EMPTY: a speech doesn't say which event it belongs to). GET eventos/{id}/discursos answers 405: there is no per-event list.
 * So the session's list is built: the event's window on its date, plus every event deputy's speeches of that day whose
 * start falls inside it (~500 calls, 4 at a time, under 3 min on the plenary). Order is by minute, then deputy id:
 * speeches of the same minute have no known order (a known limit; the aligner matches by content, not by position).
 */
const BASE = "https://dadosabertos.camara.leg.br/api/v2";
const CONCURRENCY = 4;
const LABEL = "Câmara";

export const CAMARA_NOT_FOUND = "The Câmara has no speeches for that session.";

const str = z.union([z.string(), z.number()]).transform(String).nullish().transform((v) => (v == null || v === "" ? null : v));
const eventSchema = z.object({ dados: z.object({ dataHoraInicio: z.string().min(10), dataHoraFim: str }).passthrough() }).passthrough();
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
  const start = event.data.dados.dataHoraInicio.slice(0, 16);
  const date = start.slice(0, 10);
  const end = event.data.dados.dataHoraFim?.slice(0, 16) ?? `${date}T23:59`;
  const endDate = end.slice(0, 10);

  const dep = await getJson(`${BASE}/eventos/${encodeURIComponent(eventId)}/deputados`, f, LABEL);
  if (dep.status === 404) throw new RecordNotFoundError(CAMARA_NOT_FOUND);
  const list = deputiesSchema.safeParse(dep.body);
  if (!list.success) throw unexpected();
  const deputies: Record<string, CamaraDeputy> = {};
  for (const d of list.data.dados) {
    if (d.id == null || d.nome == null || deputies[d.id]) continue;
    deputies[d.id] = { name: d.nome, party: d.siglaPartido, state: d.siglaUf, photoUrl: d.urlFoto };
  }
  const ids = Object.keys(deputies);

  const perDeputy = await mapLimit(ids, CONCURRENCY, async (id) => {
    const res = await getJson(`${BASE}/deputados/${id}/discursos?dataInicio=${date}&dataFim=${endDate}&itens=100`, f, LABEL);
    if (res.status === 404) return [];
    const parsed = speechesSchema.safeParse(res.body);
    if (!parsed.success) throw unexpected();
    return parsed.data.dados.flatMap((s, n) => {
      const at = s.dataHoraInicio?.slice(0, 16);
      if (!at || at < start || at > end) return [];
      const full = s.transcricao?.trim();
      const text = full || s.sumario?.trim();
      if (!text) return [];
      return [{ id, at, n, text, textSource: full ? ("full" as const) : ("summary" as const) }];
    });
  });

  const picked = perDeputy.flat().sort((a, b) => a.at.localeCompare(b.at) || Number(a.id) - Number(b.id) || a.n - b.n);
  if (picked.length === 0) throw new RecordNotFoundError(CAMARA_NOT_FOUND);
  const speeches = picked.map((p, i): RecordSpeech => ({
    id: `${p.id}-${p.at}-${p.n}`,
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
