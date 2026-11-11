import { z } from "zod";
import type { MemberInput, SpeechInput } from "@digestor/core/server";
import { getJson, httpTiming } from "../records/http.js";

/**
 * Câmara open-data client for the parliament monitor (https://dadosabertos.camara.leg.br). Shapes recorded 2026-11-11,
 * see test/fixtures/camara-monitor/README.md. Lists answer `{ dados, links }` and are followed through the `links`
 * entry `rel: "next"`; the bulk files are `;`-separated CSV with a BOM, regenerated nightly (04:00–07:10 UTC).
 * Callers keep at most 4 requests in flight (`mapLimit`). Code never fetches www.camara.leg.br pages.
 */
export const MONITOR_FROM = "2026-02-01";
const API = "https://dadosabertos.camara.leg.br/api/v2";
const FILES = "https://dadosabertos.camara.leg.br/arquivos";
const LABEL = "Câmara";

const text = z.union([z.string(), z.number()]).transform(String).nullish().transform((v) => (v == null || v === "" ? null : v));
const links = z.array(z.object({ rel: text, href: text }).passthrough()).nullish();
const page = <T extends z.ZodTypeAny>(item: T) => z.object({ dados: z.array(item), links }).passthrough();

const deputado = z.object({ id: z.coerce.number(), nome: z.string(), siglaPartido: text, siglaUf: text, urlFoto: text }).passthrough();
const discurso = z
  .object({
    dataHoraInicio: z.string(),
    faseEvento: z.object({ titulo: text }).passthrough().nullish(),
    tipoDiscurso: text,
    sumario: text,
    transcricao: text,
    keywords: text,
  })
  .passthrough();
const proposicao = z
  .object({ id: z.coerce.number(), siglaTipo: z.string(), numero: z.coerce.number(), ano: z.coerce.number(), ementa: text })
  .passthrough();

/** Every page of a list; a 404 on the first page is an empty list. */
async function pages<T extends z.ZodTypeAny>(f: typeof fetch, first: string, item: T): Promise<z.infer<T>[]> {
  const out: z.infer<T>[] = [];
  let url: string | null = first;
  for (let n = 0; url && n < 100; n++) {
    const res = await getJson(url, f, LABEL);
    if (res.status === 404) break;
    const body = page(item).parse(res.body);
    out.push(...body.dados);
    const next = body.links?.find((l) => l.rel === "next")?.href;
    url = next ? new URL(next, API).toString() : null;
  }
  return out;
}

const toMember = (d: z.infer<typeof deputado>): MemberInput => ({
  house: "camara", externalId: d.id, name: d.nome.trim(), party: d.siglaPartido, uf: d.siglaUf, photoUrl: d.urlFoto,
});

/** Everyone who sat in the chamber between `from` and `to` (the API lists a deputy once per stint; the last one wins). */
export async function fetchMembers(f: typeof fetch, from: string, to: string): Promise<MemberInput[]> {
  const rows = await pages(f, `${API}/deputados?dataInicio=${from}&dataFim=${to}&itens=100&ordem=ASC&ordenarPor=nome`, deputado);
  return [...new Map(rows.map((d) => [d.id, toMember(d)])).values()];
}

/** The deputies in office today. */
export async function fetchInOfficeIds(f: typeof fetch): Promise<number[]> {
  const rows = await pages(f, `${API}/deputados?itens=100&ordem=ASC&ordenarPor=nome`, deputado);
  return [...new Set(rows.map((d) => d.id))];
}

/** A deputy's speeches in [from, to] (days), oldest first. An unknown deputy (404) has none. */
export async function fetchSpeeches(f: typeof fetch, externalId: number, from: string, to: string): Promise<SpeechInput[]> {
  const url = `${API}/deputados/${externalId}/discursos?dataInicio=${from}&dataFim=${to}&itens=100&ordenarPor=dataHoraInicio&ordem=ASC`;
  const rows = await pages(f, url, discurso);
  return rows
    .map((d) => ({
      startsAt: d.dataHoraInicio.slice(0, 16),
      phase: d.faseEvento?.titulo ?? null,
      kind: d.tipoDiscurso,
      summary: decodeEntities(d.sumario ?? ""),
      text: decodeEntities(d.transcricao ?? ""),
      keywords: decodeEntities(d.keywords ?? ""),
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** The API leaves HTML entities in some summaries ("feminicídio.&nbsp;Destacou"): stored as the plain characters. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code === 160 ? 32 : code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export type YearCsv = "votacoes" | "votacoesObjetos" | "votacoesVotos";

/** Bulk files are up to ~50 MB; the API's 30 s per-call limit is too short for them. */
export const bulkTiming = { timeoutMs: 5 * 60_000, attempts: 3 };

/**
 * The year's bulk file as text (BOM included; the parser strips it). The Câmara sometimes closes the connection in the
 * middle of a large body ("terminated", seen 2026-11-11 after 15 MB), so the whole download (request and body) is
 * retried, up to 3 times. A 4xx is final.
 */
export async function fetchYearCsv(f: typeof fetch, kind: YearCsv, year: number): Promise<string> {
  const url = `${FILES}/${kind}/csv/${kind}-${year}.csv`;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, { headers: { accept: "text/csv" }, signal: AbortSignal.timeout(bulkTiming.timeoutMs) });
      if (res.ok) return await res.text();
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`${LABEL} bulk file ${kind}-${year}.csv answered ${res.status}.`), { final: true });
      throw new Error(`${LABEL} bulk file ${kind}-${year}.csv answered ${res.status}.`);
    } catch (err) {
      if ((err as { final?: boolean }).final || attempt >= bulkTiming.attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, httpTiming.delayMs * attempt));
    }
  }
}

const LABEL_RE = /^([A-Z]+) (\d+)\/(\d{4})$/;
const toBill = (p: z.infer<typeof proposicao>) => ({ id: p.id, label: `${p.siglaTipo} ${p.numero}/${p.ano}`, summary: p.ementa ?? "" });

/** A bill (proposição) by id, or by its label ("PL 3880/2024"); null when the Câmara has none. */
export async function fetchBill(
  f: typeof fetch, a: { id?: number; label?: string },
): Promise<{ id: number; label: string; summary: string } | null> {
  if (a.id !== undefined) {
    const res = await getJson(`${API}/proposicoes/${a.id}`, f, LABEL);
    if (res.status === 404) return null;
    return toBill(z.object({ dados: proposicao }).passthrough().parse(res.body).dados);
  }
  const m = a.label ? LABEL_RE.exec(a.label) : null;
  if (!m) return null;
  const [, sigla, numero, ano] = m;
  const res = await getJson(`${API}/proposicoes?siglaTipo=${sigla}&numero=${numero}&ano=${ano}`, f, LABEL);
  if (res.status === 404) return null;
  const hit = page(proposicao)
    .parse(res.body)
    .dados.find((p) => p.siglaTipo === sigla && p.numero === Number(numero) && p.ano === Number(ano));
  return hit ? toBill(hit) : null;
}
