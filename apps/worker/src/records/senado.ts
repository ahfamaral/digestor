import { z } from "zod";
import type { RecordConnector, RecordSpeech, MemberInfo } from "./connector.js";
import { RecordNotFoundError } from "./connector.js";
import { speechText, STOP } from "./align.js";
import { get as httpGet, getJson as httpGetJson, httpTiming, mapLimit } from "./http.js";

/**
 * Senado open-data client (https://legis.senado.leg.br/dadosabertos). Shapes recorded 2026-11-03, see
 * test/fixtures/senado-*.json. Three calls:
 *  - GET plenario/lista/discursos/{yyyymmdd}/{yyyymmdd}.json (Accept: application/json): sessions of the day with
 *    their speeches (speaker code, name, party, UF, a variable-length `Resumo` summary (~100-900 chars), NO full text, no per-speech time);
 *  - GET discurso/texto-integral/{CodigoPronunciamento} (Accept: text/plain; JSON answers 406): the full text, 1 call per speech;
 *  - GET senador/{codigo}.json: the senator; an unknown code answers 200 without `Parlamentar`.
 * An empty day answers 200 with `Sessoes: null`. This API's JSON may give one object where a list is expected.
 */
const BASE = "https://legis.senado.leg.br/dadosabertos";
const TEXT_CONCURRENCY = 4;

export { RecordNotFoundError, type RecordSpeech };

const str = z.union([z.string(), z.number()]).transform(String).nullish().transform((v) => (v == null || v === "" ? null : v));
const many = <T extends z.ZodTypeAny>(item: T) =>
  z
    .union([z.array(item), item])
    .nullish()
    .transform((v): z.output<T>[] => (v == null ? [] : ((Array.isArray(v) ? v : [v]) as z.output<T>[])));

const pronouncementSchema = z.object({
  CodigoPronunciamento: str,
  id: str,
  CodigoParlamentar: str,
  NomeAutor: str,
  Partido: str,
  UF: str,
  Resumo: str,
}).passthrough();
const sessionSchema = z.object({
  CodigoSessao: str,
  HoraInicio: str,
  Pronunciamentos: z.object({ Pronunciamento: many(pronouncementSchema) }).passthrough().nullish(),
}).passthrough();
const discursosSchema = z.object({
  DiscursosSessao: z.object({ Sessoes: z.object({ Sessao: many(sessionSchema) }).passthrough().nullish() }).passthrough(),
}).passthrough();
const senadorSchema = z.object({
  DetalheParlamentar: z.object({
    Parlamentar: z
      .object({
        IdentificacaoParlamentar: z.object({
          CodigoParlamentar: str,
          NomeParlamentar: str,
          NomeCompletoParlamentar: str,
          SiglaPartidoParlamentar: str,
          UfParlamentar: str,
          UrlFotoParlamentar: str,
        }).passthrough(),
      })
      .passthrough()
      .nullish(),
  }).passthrough(),
}).passthrough();

/** Per-call limits (shared with the Câmara client); tests set `delayMs` to 0. */
export const senadoTiming = httpTiming;

const get = (url: string, accept: string, f: typeof fetch) => httpGet(url, accept, f, "Senado");
const getJson = (url: string, f: typeof fetch) => httpGetJson(url, f, "Senado");

function compactText(raw: string): string {
  return raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchText(p: z.infer<typeof pronouncementSchema>, id: string, f: typeof fetch): Promise<{ text: string; textSource: "full" | "summary" }> {
  const res = await get(`${BASE}/discurso/texto-integral/${id}`, "text/plain", f);
  // 406 means our own request is wrong (Accept), not that the record lacks the speech: fail loudly.
  if (res.status === 404) return { text: p.Resumo ?? "", textSource: "summary" };
  if (!res.ok) throw new Error(`Senado API answered ${res.status}.`);
  const text = compactText(await res.text());
  return text ? { text, textSource: "full" } : { text: p.Resumo ?? "", textSource: "summary" };
}

/**
 * The speeches of a plenary day. Order is INFERRED and unverified (the API has no per-speech time): ascending
 * `CodigoPronunciamento` within a session (consistent with the Diario `PaginaInicial` in the fixture); ids are not
 * chronological across sessions, hence sessions are sorted by `HoraInicio`. The list itself comes newest-first.
 * Speeches without a senator code (external guests) are dropped and `order` is renumbered without gaps. Texts keep
 * the speaker prefix ("O SR. ... –") and stage directions. With `sessionCode` only that session (`CodigoSessao`)
 * is kept. Cost: 1 call for the list + 1 per speech for its text.
 */
export async function fetchSenadoSpeeches(date: string, sessionCode: string | null, f: typeof fetch = fetch): Promise<RecordSpeech[]> {
  const day = date.replaceAll("-", "");
  const { status, body } = await getJson(`${BASE}/plenario/lista/discursos/${day}/${day}.json`, f);
  if (status === 404) throw new RecordNotFoundError();
  const parsed = discursosSchema.safeParse(body);
  if (!parsed.success) throw new Error("The Senado API answered with an unexpected shape.");
  let sessions = parsed.data.DiscursosSessao.Sessoes?.Sessao ?? [];
  if (sessionCode) {
    sessions = sessions.filter((s) => s.CodigoSessao === sessionCode);
    if (sessions.length === 0) throw new RecordNotFoundError(`That Senado session wasn't found on ${date.split("-").reverse().join("/")}.`);
  }
  sessions = [...sessions].sort((a: (typeof sessions)[number], b: (typeof sessions)[number]) => (a.HoraInicio ?? "").localeCompare(b.HoraInicio ?? ""));

  const picked: { p: z.infer<typeof pronouncementSchema>; id: string; code: string }[] = [];
  for (const s of sessions) {
    const list = (s.Pronunciamentos?.Pronunciamento ?? [])
      .map((p) => ({ p, id: p.CodigoPronunciamento ?? p.id, code: p.CodigoParlamentar }))
      .filter((x): x is { p: typeof x.p; id: string; code: string } => x.id != null && x.code != null)
      .sort((a, b) => Number(a.id) - Number(b.id));
    picked.push(...list);
  }
  if (picked.length === 0) throw new RecordNotFoundError();

  const texts = await mapLimit(picked, TEXT_CONCURRENCY, (x) => fetchText(x.p, x.id, f));
  return picked.map((x, i) => ({
    id: x.id,
    order: i + 1,
    officialId: x.code,
    name: x.p.NomeAutor ?? "",
    party: x.p.Partido,
    state: x.p.UF,
    text: texts[i]?.text ?? "",
    textSource: texts[i]?.textSource ?? "summary",
  }));
}

export async function fetchSenador(
  codigo: string,
  f: typeof fetch = fetch,
): Promise<{ officialId: string; displayName: string; fullName: string | null; party: string | null; state: string | null; photoUrl: string | null }> {
  const { status, body } = await getJson(`${BASE}/senador/${encodeURIComponent(codigo)}.json`, f);
  if (status === 404) throw new RecordNotFoundError("The Senado record has no such senator.");
  const parsed = senadorSchema.safeParse(body);
  if (!parsed.success) throw new Error("The Senado API answered with an unexpected shape.");
  const id = parsed.data.DetalheParlamentar.Parlamentar?.IdentificacaoParlamentar;
  if (!id) throw new RecordNotFoundError("The Senado record has no such senator.");
  return {
    officialId: id.CodigoParlamentar ?? codigo,
    displayName: id.NomeParlamentar ?? id.NomeCompletoParlamentar ?? codigo,
    fullName: id.NomeCompletoParlamentar,
    party: id.SiglaPartidoParlamentar,
    state: id.UfParlamentar,
    photoUrl: id.UrlFotoParlamentar,
  };
}

/** The Senado behind the connector interface: the day's speeches and, once per speaker, the senator's page (a 404 leaves the speech's own fields). */
export const senadoConnector: RecordConnector = {
  chamber: "senado",
  async fetchRecord(ref, f) {
    if (ref.chamber !== "senado") throw new Error("The Senado connector got a ref of another house.");
    const speeches = await fetchSenadoSpeeches(ref.date, ref.sessionCode, f);
    const members: Record<string, MemberInfo> = {};
    const ids = [...new Set(speeches.flatMap((s) => (s.officialId ? [s.officialId] : [])))];
    await mapLimit(ids, TEXT_CONCURRENCY, async (id) => {
      try {
        const sen = await fetchSenador(id, f);
        members[id] = { displayName: sen.displayName, fullName: sen.fullName, party: sen.party, state: sen.state, photoUrl: sen.photoUrl };
      } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err;
      }
    });
    return { speeches, date: ref.date, members };
  },
  speechText: (s) => speechText(s.text),
  stopWords: STOP,
};
