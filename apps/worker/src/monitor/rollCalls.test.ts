import { describe, expect, it } from "vitest";
import { monitorFixture } from "./fakeCamaraMonitor.js";
import { parseCsv } from "./bulk.js";
import { mainBill, toRollCalls, toVotes } from "./rollCalls.js";

const votacoes = parseCsv(monitorFixture("votacoes-2026.excerpt.csv"));
const objetos = parseCsv(monitorFixture("votacoesObjetos-2026.excerpt.csv"));
const votos = parseCsv(monitorFixture("votacoesVotos-2026.excerpt.csv"));

describe("parseCsv", () => {
  it("reads the BOM header and a quoted field with an embedded line break as one row", () => {
    expect(Object.keys(votacoes[0]!)[0]).toBe("id");
    expect(votacoes).toHaveLength(6);
    expect(votacoes.find((r) => r.id === "2622112-4")!.descricao).toContain("\r\n");
    expect(parseCsv('﻿"a";"b"\n"1";"x\r\ny"\n')).toEqual([{ a: "1", b: "x\r\ny" }]);
  });
});

describe("toRollCalls", () => {
  const rows = toRollCalls(votacoes, objetos);
  const byId = new Map(rows.map((r) => [r.id, r]));

  it("keeps plenary roll calls only (no symbolic or committee votes)", () => {
    expect([...byId.keys()].sort()).toEqual(["2449741-72", "2462009-57", "2600277-9", "2601223-8"]);
  });

  it("names the main bill the requests refer to", () => {
    expect(byId.get("2449741-72")).toMatchObject({
      date: "2026-03-10", yes: 408, no: 13, other: 1, billLabel: "PL 2942/2024", description: expect.stringMatching(/^Mantido o texto/),
    });
    expect(byId.get("2462009-57")).toMatchObject({ billLabel: "PL 3880/2024", yes: 116, no: 311, other: 2 });
    expect(byId.get("2462009-57")!.needsBill).toEqual({ label: "PL 3880/2024" });
  });

  it("an urgency request with no main bill links to the request itself", () => {
    const r = byId.get("2601223-8")!;
    expect(r.billLabel).toBe("REQ 284/2026");
    expect(r.billId).toEqual(expect.any(Number));
    expect(r.billSummary).not.toBe("");
    expect(r.needsBill).toBeNull();
  });

  it("a roll call with no objects and no presented proposição has no bill", () => {
    expect(byId.get("2600277-9")).toMatchObject({ billLabel: null, billId: null, billSummary: "", needsBill: null });
  });
});

describe("mainBill", () => {
  const obj = (titulo: string, sigla = "REQ", numero = "1", ano = "2026", id = "9", ementa = "e") => ({
    proposicao_titulo: titulo, proposicao_siglaTipo: sigla, proposicao_numero: numero, proposicao_ano: ano, proposicao_id: id,
    proposicao_ementa: ementa,
  });

  it("takes id and summary from the bill's own object when it is there", () => {
    expect(mainBill([obj("EMP 1 => PL 5/2025"), obj("PL 5/2025", "PL", "5", "2025", "77", "Ementa do PL")])).toEqual({
      label: "PL 5/2025", id: 77, summary: "Ementa do PL",
    });
  });

  it("returns null when nothing names a main bill", () => {
    expect(mainBill([obj("REQ 284/2026")])).toBeNull();
    expect(mainBill([])).toBeNull();
  });

  it("an id is a positive number or nothing", () => {
    expect(mainBill([obj("PL 5/2025", "PL", "5", "2025", "0")])).toEqual({ label: "PL 5/2025", id: null, summary: "e" });
  });
});

describe("toVotes", () => {
  const v = toVotes(votos);

  it("groups votes by roll call, labels as published", () => {
    const mine = (id: string) => v.get(id)!.find((x) => x.externalId === 204407)?.vote;
    expect(mine("2449741-72")).toBe("Sim");
    expect(mine("2462009-57")).toBe("Não");
    expect(v.get("2449741-72")!.some((x) => x.vote === "Artigo 17")).toBe(true);
    expect(v.get("2449741-72")!.find((x) => x.externalId === 204407)).toEqual({
      externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS", vote: "Sim",
    });
  });

  it("skips rows with no vote", () => {
    const rows = toVotes([{ idVotacao: "1-1", voto: "", deputado_id: "5", deputado_nome: "X", deputado_siglaPartido: "P", deputado_siglaUf: "SP" }]);
    expect(rows.get("1-1") ?? []).toEqual([]);
  });
});
