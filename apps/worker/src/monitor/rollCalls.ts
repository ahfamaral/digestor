import { parse } from "csv-parse/sync";
import type { RollCallInput } from "@digestor/core/server";

/**
 * Plenary roll calls and per-deputy votes from the Câmara's yearly bulk files (votacoes, votacoesObjetos,
 * votacoesVotos; see test/fixtures/camara-monitor/README.md). Only roll calls are kept: plenary votações with
 * recorded votes. Everything is stored as published; labels like "Artigo 17" are not rewritten.
 */
export type CsvRow = Record<string, string>;

/** `;`-separated, BOM, every field quoted; quoted fields may hold line breaks. */
export function parseCsv(text: string): CsvRow[] {
  return parse(text, { delimiter: ";", bom: true, columns: true, relax_quotes: true, skip_empty_lines: true }) as CsvRow[];
}

const MAIN_TYPES = new Set(["PL", "PLP", "PEC", "MPV", "PDL", "PRC", "PLV"]);
const POINTS_TO = /=>\s*([A-Z]+ \d+\/\d{4})/;
const ownLabel = (o: CsvRow) =>
  o.proposicao_siglaTipo && o.proposicao_numero && o.proposicao_ano ? `${o.proposicao_siglaTipo} ${o.proposicao_numero}/${o.proposicao_ano}` : null;
const positiveId = (s: string | undefined) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const num = (s: string | undefined) => Number(s) || 0;

/**
 * The bill a votação is about. Its objects are requests, amendments, opinions and sometimes the bill itself;
 * "X => PL 3880/2024" titles point at the bill. Each pointer counts 1, each object of a main type counts as its own
 * label; the most counted label wins. Id and summary come from the bill's own object when it is among them.
 */
export function mainBill(objects: CsvRow[]): { label: string; id: number | null; summary: string } | null {
  const counts = new Map<string, number>();
  const add = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const o of objects) {
    const m = POINTS_TO.exec(o.proposicao_titulo ?? "");
    if (m) add(m[1]!);
    const own = ownLabel(o);
    if (own && MAIN_TYPES.has(o.proposicao_siglaTipo!)) add(own);
  }
  let best: string | null = null;
  for (const [label, n] of counts) if (best === null || n > counts.get(best)!) best = label;
  if (best === null) return null;
  const self = objects.find((o) => ownLabel(o) === best);
  return { label: best, id: positiveId(self?.proposicao_id), summary: self?.proposicao_ementa ?? "" };
}

export type RollCallRow = RollCallInput & { needsBill: { id?: number; label?: string } | null };

/**
 * Plenary roll calls. With no main bill, a votação on a single proposição (an urgency request, an appeal) points at
 * that proposição itself; with no objects at all, at `ultimaApresentacaoProposicao_idProposicao` when it is an id.
 * `needsBill` says what `fetchBill` must still look up (id or summary missing).
 */
export function toRollCalls(votacoes: CsvRow[], objetos: CsvRow[]): RollCallRow[] {
  const objectsOf = new Map<string, CsvRow[]>();
  for (const o of objetos) {
    const list = objectsOf.get(o.idVotacao!) ?? [];
    list.push(o);
    objectsOf.set(o.idVotacao!, list);
  }
  const out: RollCallRow[] = [];
  for (const v of votacoes) {
    const yes = num(v.votosSim);
    const no = num(v.votosNao);
    const other = num(v.votosOutros);
    if (v.siglaOrgao !== "PLEN" || yes + no + other === 0) continue;
    const objs = objectsOf.get(v.id!) ?? [];
    const first = objs[0];
    const bill =
      mainBill(objs) ??
      (first && ownLabel(first)
        ? { label: ownLabel(first)!, id: positiveId(first.proposicao_id), summary: first.proposicao_ementa ?? "" }
        : null);
    const presented = positiveId(v.ultimaApresentacaoProposicao_idProposicao);
    const needsBill = bill
      ? bill.id === null || bill.summary === ""
        ? bill.id === null ? { label: bill.label } : { id: bill.id }
        : null
      : presented
        ? { id: presented }
        : null;
    out.push({
      id: v.id!,
      date: v.data!,
      registeredAt: v.dataHoraRegistro || null,
      description: (v.descricao ?? "").trim(),
      yes, no, other,
      billId: bill?.id ?? null,
      billLabel: bill?.label ?? null,
      billSummary: bill?.summary ?? "",
      needsBill,
    });
  }
  return out;
}

export type VoteCsv = { externalId: number; name: string; party: string; uf: string; vote: string };

/** Votes grouped by roll call id; rows without a vote are not a recorded vote and are skipped. */
export function toVotes(votos: CsvRow[]): Map<string, VoteCsv[]> {
  const out = new Map<string, VoteCsv[]>();
  for (const r of votos) {
    const vote = (r.voto ?? "").trim();
    const externalId = positiveId(r.deputado_id);
    if (!vote || externalId === null) continue;
    const list = out.get(r.idVotacao!) ?? [];
    list.push({ externalId, name: (r.deputado_nome ?? "").trim(), party: r.deputado_siglaPartido ?? "", uf: r.deputado_siglaUf ?? "", vote });
    out.set(r.idVotacao!, list);
  }
  return out;
}
