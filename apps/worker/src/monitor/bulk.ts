import { parse } from "csv-parse/sync";
import type { BillInput, SessionInput } from "@digestor/core/server";
import { billLabel, idFromUri } from "@digestor/core";
import { MONITOR_FROM } from "./camara.js";

/**
 * Parsers for the Câmara's yearly bulk files (https://dadosabertos.camara.leg.br/arquivos/{kind}/csv/{kind}-{year}.csv,
 * see test/fixtures/camara-monitor/README.md): roll-call guidance, events, presence at events, bills and their authors.
 * Rows are kept as published; only the rows the monitor stores are mapped.
 */
export type CsvRow = Record<string, string>;

/**
 * `;`-separated, BOM, every field quoted; quoted fields may hold line breaks. With `keep`, other columns are dropped
 * while parsing (proposicoes-2026.csv is 44 MB, most of it long text the monitor doesn't store).
 */
export function parseCsv(text: string, keep?: string[]): CsvRow[] {
  const columns = keep ? (header: string[]) => header.map((h) => (keep.includes(h) ? h : false)) : true;
  return parse(text, { delimiter: ";", bom: true, columns, relax_quotes: true, skip_empty_lines: true }) as CsvRow[];
}

const positiveId = (s: string | undefined) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Party and bloc guidance (votacoesOrientacoes) of the given roll calls, in file order; an empty orientation is kept. */
export function toOrientations(rows: CsvRow[], rollCallIds: Set<string>): Map<string, { bloc: string; orientation: string }[]> {
  const out = new Map<string, { bloc: string; orientation: string }[]>();
  for (const r of rows) {
    const id = r.idVotacao ?? "";
    const bloc = (r.siglaBancada ?? "").trim();
    if (!rollCallIds.has(id) || !bloc) continue;
    const list = out.get(id) ?? [];
    list.push({ bloc, orientation: (r.orientacao ?? "").trim() });
    out.set(id, list);
  }
  return out;
}

/** Plenary deliberative sessions (eventos with `descricaoTipo` "Sessão Deliberativa"), every status. */
export function toSessions(rows: CsvRow[]): SessionInput[] {
  const out: SessionInput[] = [];
  for (const r of rows) {
    const id = positiveId(r.id);
    if (r.descricaoTipo !== "Sessão Deliberativa" || id === null || !r.dataHoraInicio) continue;
    out.push({ id, startsAt: r.dataHoraInicio.slice(0, 16), description: (r.descricao ?? "").trim(), status: (r.situacao ?? "").trim() });
  }
  return out;
}

/** Presence (eventosPresencaDeputados) at the given sessions. */
export function toPresence(rows: CsvRow[], sessionIds: Set<number>): { sessionId: number; externalId: number }[] {
  const out: { sessionId: number; externalId: number }[] = [];
  for (const r of rows) {
    const sessionId = positiveId(r.idEvento);
    const externalId = positiveId(r.idDeputado);
    if (sessionId === null || externalId === null || !sessionIds.has(sessionId)) continue;
    out.push({ sessionId, externalId });
  }
  return out;
}

/** The columns `toBills` reads (for `parseCsv(text, BILL_COLUMNS)`). */
export const BILL_COLUMNS = ["id", "siglaTipo", "numero", "ano", "ementa", "dataApresentacao", "uriPropPrincipal"];
/** The columns `toBillAuthors` reads. */
export const AUTHOR_COLUMNS = ["idProposicao", "idDeputadoAutor", "ordemAssinatura"];

/**
 * Bills (proposicoes) presented on or after `from`; the year's file also lists older bills that moved this year. Each
 * keeps its main bill (`uriPropPrincipal`: the bill an opinion, substitute or amendment belongs to, or the one a bill is
 * attached to); an item numbered inside its main bill (year 0, "PRL 1") gets the main bill's label when any row of the
 * file is that bill (else null: the refresh asks the API, `fillMainBillLabels`).
 */
export function toBills(rows: CsvRow[], from = MONITOR_FROM): BillInput[] {
  const labelOf = new Map<number, string>();
  for (const r of rows) {
    const id = positiveId(r.id);
    const year = Number(r.ano) || 0;
    if (id !== null && r.siglaTipo && year > 0) labelOf.set(id, billLabel(r.siglaTipo, Number(r.numero) || 0, year));
  }
  const out: BillInput[] = [];
  for (const r of rows) {
    const id = positiveId(r.id);
    const presentedAt = (r.dataApresentacao ?? "").slice(0, 16);
    if (id === null || !r.siglaTipo || presentedAt < from) continue;
    const year = Number(r.ano) || 0;
    const mainBillId = idFromUri(r.uriPropPrincipal);
    out.push({
      id, type: r.siglaTipo, number: Number(r.numero) || 0, year, summary: (r.ementa ?? "").trim(), presentedAt,
      mainBillId, mainBillLabel: year === 0 && mainBillId !== null ? (labelOf.get(mainBillId) ?? null) : null,
    });
  }
  return out;
}

/** Deputies' authorship of the given bills; committees, the Executive and senators have no `idDeputadoAutor` and are skipped. */
export function toBillAuthors(rows: CsvRow[], billIds: Set<number>): { billId: number; externalId: number; firstAuthor: boolean }[] {
  const out: { billId: number; externalId: number; firstAuthor: boolean }[] = [];
  for (const r of rows) {
    const billId = positiveId(r.idProposicao);
    const externalId = positiveId(r.idDeputadoAutor);
    if (billId === null || externalId === null || !billIds.has(billId)) continue;
    out.push({ billId, externalId, firstAuthor: r.ordemAssinatura === "1" });
  }
  return out;
}
