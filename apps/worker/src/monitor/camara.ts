import { z } from "zod";
import type { ExternalMandate, Position } from "@digestor/core";
import type { HistoryInput, MemberInput, ProfileInput, SpeechInput } from "@digestor/core/server";
import { getJson, httpTiming } from "../records/http.js";

/**
 * Câmara open-data client for the parliament monitor (https://dadosabertos.camara.leg.br). Shapes recorded 2026-11-11,
 * see test/fixtures/camara-monitor/README.md. Lists answer `{ dados, links }` and are followed through the `links`
 * entry `rel: "next"`; the bulk files are `;`-separated CSV with a BOM, regenerated nightly (04:00–07:10 UTC).
 * Callers keep at most 4 requests in flight (`mapLimit`). Code never fetches www.camara.leg.br pages.
 */
export const MONITOR_FROM = "2026-02-01";
/** The 57th legislature began on 1 Feb 2023: history, fronts and positions are read from then. */
export const LEGISLATURE_FROM = "2023-02-01";
const LEGISLATURE = 57;
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

const historico = z
  .object({ dataHora: z.string(), siglaPartido: text, siglaUf: text, situacao: text, descricaoStatus: text, idLegislatura: z.coerce.number().nullish() })
  .passthrough();

/**
 * A deputy's history in this legislature (`/historico`: party changes, leave, return), as published. The API also lists
 * rows of earlier legislatures dated at this one's start (73806: a PFL row of legislature 49 dated 2023-02-01), so only
 * rows of legislature 57 (or with no legislature) are kept. An unknown deputy (404) has none.
 */
export async function fetchHistory(f: typeof fetch, externalId: number): Promise<HistoryInput[]> {
  const rows = await pages(f, `${API}/deputados/${externalId}/historico`, historico);
  return rows
    .filter((r) => r.idLegislatura == null || r.idLegislatura === LEGISLATURE)
    .map((r) => ({ at: r.dataHora.slice(0, 16), party: r.siglaPartido, uf: r.siglaUf, status: r.situacao, description: r.descricaoStatus ?? "" }));
}

const profissao = z.object({ titulo: text }).passthrough();
const mandatoExterno = z
  .object({ cargo: text, municipio: text, siglaUf: text, anoInicio: text, anoFim: text, siglaPartidoEleicao: text })
  .passthrough();
const frente = z.object({ titulo: text, idLegislatura: z.coerce.number().nullish() }).passthrough();
const orgao = z
  .object({ siglaOrgao: text, nomeOrgao: text, nomePublicacao: text, titulo: text, dataInicio: text, dataFim: text })
  .passthrough();

const year = (s: string | null) => (s && /^\d{4}$/.test(s) ? Number(s) : null);

/**
 * Consecutive terms in one office, place, UF and party become one span ("Vereador(a) · Porto Alegre (RS) · 2009–2018");
 * a gap, a party change or an open-ended term keeps them apart. Oldest first.
 */
export function mergeMandates(rows: ExternalMandate[]): ExternalMandate[] {
  const sorted = [...rows].sort((a, b) => a.from - b.from || (a.to ?? Infinity) - (b.to ?? Infinity));
  const out: ExternalMandate[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (
      prev && prev.to !== null && prev.office === r.office && prev.place === r.place && prev.uf === r.uf && prev.party === r.party &&
      r.from <= prev.to + 1
    ) {
      out[out.length - 1] = { ...prev, to: r.to === null ? null : Math.max(prev.to, r.to) };
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * A deputy's profile: profession, earlier mandates (merged), the parliamentary fronts of this legislature and the seats
 * in bodies since its start (every page). Four calls, one after another; an unknown deputy gives an empty profile.
 */
export async function fetchProfile(f: typeof fetch, externalId: number): Promise<ProfileInput> {
  const base = `${API}/deputados/${externalId}`;
  const professions = await pages(f, `${base}/profissoes`, profissao);
  const mandates = await pages(f, `${base}/mandatosExternos`, mandatoExterno);
  const fronts = await pages(f, `${base}/frentes`, frente);
  const bodies = await pages(f, `${base}/orgaos?dataInicio=${LEGISLATURE_FROM}&itens=100`, orgao);
  return {
    profession: professions.find((p) => p.titulo)?.titulo ?? null,
    externalMandates: mergeMandates(
      mandates.flatMap((m) => {
        const from = year(m.anoInicio);
        return m.cargo && from !== null
          ? [{ office: m.cargo, place: m.municipio ?? "", uf: m.siglaUf, from, to: year(m.anoFim), party: m.siglaPartidoEleicao }]
          : [];
      }),
    ),
    fronts: fronts.filter((r) => r.idLegislatura === LEGISLATURE && r.titulo).map((r) => r.titulo!),
    positions: bodies.flatMap((o): Position[] =>
      o.siglaOrgao && o.dataInicio
        ? [{
            body: o.siglaOrgao, bodyName: o.nomePublicacao ?? o.nomeOrgao ?? o.siglaOrgao, title: o.titulo ?? "",
            from: o.dataInicio.slice(0, 10), to: o.dataFim ? o.dataFim.slice(0, 10) : null,
          }]
        : [],
    ),
  };
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

export type YearCsv =
  | "votacoes" | "votacoesObjetos" | "votacoesVotos" | "votacoesOrientacoes"
  | "eventos" | "eventosPresencaDeputados" | "proposicoes" | "proposicoesAutores";

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
