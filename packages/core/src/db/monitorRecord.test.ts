import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { parlSpeeches } from "./schema.ts";
import { replaceSpeechWindow, replaceVotes, upsertMembers, upsertRollCalls, type MemberInput, type SpeechInput } from "./monitor.ts";
import {
  listBlocs, replaceBlocs,
  dropMisfiledSpeeches, fillSpeechParties, getHistory, getPresence, getRollCall, listMemberBills, memberBillIds, membersNeedingProfile, replaceBillAuthors, replaceHistory,
  replaceOrientations, replacePresence, setProfile, upsertBills, upsertSessions, mainBillsWithoutLabel, setMainBillLabels, type HistoryInput,
} from "./monitorRecord.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(
    "TRUNCATE parl_bloc_parties, parl_blocs, parl_presence, parl_sessions, parl_bill_authors, parl_bills, parl_orientations, parl_member_history, parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE",
  );
  await pool.end();
});

const member = (externalId: number, name: string, party = "PL", uf = "AL"): MemberInput => ({ house: "camara", externalId, name, party, uf, photoUrl: null });
const speech = (startsAt: string, text: string): SpeechInput => ({ startsAt, phase: "Breves Comunicações", kind: "Discurso", summary: "", text, keywords: "" });
const h = (at: string, party: string, status = "Exercício", description = ""): HistoryInput => ({ at, party, uf: "AL", status, description });
export const gasparHistory = [
  h("2023-02-01T00:00", "UNIÃO", "", "Nome no início da legislatura / Partido no início da legislatura"),
  h("2023-02-01T12:05", "UNIÃO", "Exercício", "Entrada - Posse de Eleito Titular - Posse na Sessão Preparatória"),
  h("2026-04-29T22:10", "PL", "Exercício", "Alteração de partido"),
];

describe("monitor record", () => {
  it("dropMisfiledSpeeches removes the copy filed under the wrong deputy and keeps everything else", async () => {
    const ids = await upsertMembers(db, [member(160535, "Marcon", "PT", "RS"), member(220550, "Mauricio Marcon", "PL", "RS")]);
    const marcon = ids.get(160535)!;
    const mauricio = ids.get(220550)!;
    await replaceHistory(db, marcon, [{ at: "2023-02-01T00:00", party: "PT", uf: "RS", status: "Exercício", description: "" }]);
    await replaceHistory(db, mauricio, [{ at: "2023-02-01T00:00", party: "PL", uf: "RS", status: "Exercício", description: "" }]);
    const his = "O SR. MAURICIO MARCON (PL - RS. Sem revisão do orador.) - Presidente Charles, é sempre uma alegria.";
    const own = "O SR. MARCON (PT - RS. Sem revisão do orador.) - Sr. Presidente, quero registrar.";
    await replaceSpeechWindow(db, marcon, "2026-02-01", "2026-11-11", [speech("2026-06-30T16:20", his), speech("2026-06-30T17:00", own)]);
    await replaceSpeechWindow(db, mauricio, "2026-02-01", "2026-11-11", [speech("2026-06-30T16:20", his)]);
    await fillSpeechParties(db);
    expect(await dropMisfiledSpeeches(db)).toBe(1);
    const rows = await db.select({ memberId: parlSpeeches.memberId, text: parlSpeeches.text }).from(parlSpeeches).orderBy(parlSpeeches.id);
    expect(rows).toEqual([{ memberId: marcon, text: own }, { memberId: mauricio, text: his }]);
    expect(await dropMisfiledSpeeches(db)).toBe(0);
  });


  it("fillSpeechParties takes the party on the day", async () => {
    const ids = await upsertMembers(db, [member(220576, "Alfredo Gaspar"), member(1, "Sem Histórico")]);
    await replaceHistory(db, ids.get(220576)!, gasparHistory);
    await replaceSpeechWindow(db, ids.get(220576)!, "2026-02-01", "2026-11-11", [speech("2026-04-29T18:00", "antes"), speech("2026-05-01T10:00", "depois")]);
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-11", [speech("2026-05-02T10:00", "sem")]);
    expect(await fillSpeechParties(db)).toBe(2);
    const rows = await db.select().from(parlSpeeches).orderBy(parlSpeeches.startsAt);
    expect(rows.map((r) => [r.text, r.party, r.uf])).toEqual([["antes", "UNIÃO", "AL"], ["depois", "PL", "AL"], ["sem", null, null]]);
  });

  it("membersNeedingProfile: all, or only those never refreshed", async () => {
    const ids = await upsertMembers(db, [member(204407, "Fernanda Melchionna"), member(1, "Outro")]);
    await setProfile(db, ids.get(204407)!, { profession: "Bibliotecária", externalMandates: [], fronts: ["Frente X"], positions: [] });
    expect((await membersNeedingProfile(db, "camara", true)).map((m) => m.externalId).sort()).toEqual([1, 204407]);
    expect((await membersNeedingProfile(db, "camara", false)).map((m) => m.externalId)).toEqual([1]);
  });

  it("replaceHistory replaces the member's rows", async () => {
    const ids = await upsertMembers(db, [member(220576, "Alfredo Gaspar")]);
    await replaceHistory(db, ids.get(220576)!, gasparHistory);
    await replaceHistory(db, ids.get(220576)!, gasparHistory.slice(2));
    expect((await getHistory(db, ids.get(220576)!)).map((r) => r.party)).toEqual(["PL"]);
  });
});

describe("presence, bills and roll calls", () => {
  it("getPresence counts closed deliberative sessions while in office", async () => {
    const ids = await upsertMembers(db, [member(1, "Suplente"), member(2, "Sem Histórico")]);
    const a = ids.get(1)!;
    await replaceHistory(db, a, [h("2026-03-01T10:00", "PSB", "Exercício", "Entrada - Posse de Suplente")]);
    await upsertSessions(db, [
      { id: 10, startsAt: "2026-02-24T14:00", description: "Sessão Deliberativa Extraordinária", status: "Encerrada" },
      { id: 11, startsAt: "2026-03-02T18:00", description: "Sessão Deliberativa Extraordinária", status: "Encerrada" },
      { id: 12, startsAt: "2026-03-03T14:00", description: "Sessão Deliberativa Ordinária", status: "Encerrada" },
      { id: 13, startsAt: "2026-03-04T14:00", description: "Sessão Deliberativa Ordinária", status: "Cancelada" },
      { id: 14, startsAt: "2025-12-01T14:00", description: "Sessão Deliberativa Ordinária", status: "Encerrada" },
    ]);
    const other = (await upsertMembers(db, [member(3, "Outro")])).get(3)!;
    await replacePresence(db, [10, 11, 12], [{ sessionId: 10, memberId: a }, { sessionId: 11, memberId: a }, { sessionId: 12, memberId: other }]);
    expect(await getPresence(db, a, 2026)).toEqual({
      sessions: 2, present: 1, missing: [{ id: 12, startsAt: "2026-03-03T14:00", description: "Sessão Deliberativa Ordinária" }],
    });
    expect(await getPresence(db, ids.get(2)!, 2026)).toBeNull();
  });

  it("getPresence leaves out sessions nobody's presence was recorded for (joint veto sessions)", async () => {
    const ids = await upsertMembers(db, [member(1, "A"), member(2, "B")]);
    for (const id of [ids.get(1)!, ids.get(2)!]) await replaceHistory(db, id, [h("2026-02-01T12:00", "PT", "Exercício", "Entrada")]);
    await upsertSessions(db, [
      { id: 20, startsAt: "2026-04-29T14:00", description: "Sessão Deliberativa Ordinária", status: "Encerrada" },
      { id: 21, startsAt: "2026-04-30T10:35", description: "Deliberação do Veto nº 3/26 (Dosimetria de Penas)", status: "Encerrada" },
    ]);
    await replacePresence(db, [20, 21], [{ sessionId: 20, memberId: ids.get(2)! }]);
    expect(await getPresence(db, ids.get(1)!, 2026)).toEqual({
      sessions: 1, present: 0, missing: [{ id: 20, startsAt: "2026-04-29T14:00", description: "Sessão Deliberativa Ordinária" }],
    });
  });

  it("getPresence compares to the minute: a session before the swearing-in that day is not counted", async () => {
    const ids = await upsertMembers(db, [member(1, "Volta"), member(2, "Presente")]);
    const a = ids.get(1)!;
    await replaceHistory(db, a, [
      h("2026-02-01T12:00", "PT", "Exercício", "Entrada"),
      h("2026-03-10T09:00", "PT", "Licença", "Saída - Licença para Tratamento de Saúde"),
      h("2026-03-20T17:01", "PT", "Exercício", "Entrada - Reassunção"),
    ]);
    await upsertSessions(db, [
      { id: 30, startsAt: "2026-03-10T08:00", description: "antes da licença", status: "Encerrada" },
      { id: 31, startsAt: "2026-03-10T14:00", description: "depois da saída", status: "Encerrada" },
      { id: 32, startsAt: "2026-03-20T14:00", description: "antes da posse", status: "Encerrada" },
      { id: 33, startsAt: "2026-03-20T18:00", description: "depois da posse", status: "Encerrada" },
    ]);
    const b = ids.get(2)!;
    await replacePresence(db, [30, 31, 32, 33], [30, 31, 32, 33].map((sessionId) => ({ sessionId, memberId: b })));
    const p = await getPresence(db, a, 2026);
    expect(p!.sessions).toBe(2);
    expect(p!.missing.map((m) => m.id)).toEqual([30, 33]);
  });

  it("listMemberBills counts by type and filters", async () => {
    const ids = await upsertMembers(db, [member(204407, "Fernanda Melchionna")]);
    const f = ids.get(204407)!;
    await upsertBills(db, [
      { id: 1, type: "PL", number: 10, year: 2026, summary: "a", presentedAt: "2026-02-10T10:00" },
      { id: 2, type: "PL", number: 11, year: 2026, summary: "b", presentedAt: "2026-03-10T10:00" },
      { id: 2600034, type: "RCP", number: 1, year: 2026, summary: "CPI Banco Master", presentedAt: "2026-02-02T09:54" },
    ]);
    await replaceBillAuthors(db, [1, 2, 2600034], [
      { billId: 1, memberId: f, firstAuthor: true }, { billId: 2, memberId: f, firstAuthor: false }, { billId: 2600034, memberId: f, firstAuthor: true },
    ]);
    const all = await listMemberBills(db, f, {});
    expect(all.total).toBe(3);
    expect(all.byType).toEqual([{ type: "PL", n: 2 }, { type: "RCP", n: 1 }]);
    expect(all.rows.map((r) => [r.id, r.firstAuthor])).toEqual([[2, false], [1, true], [2600034, true]]);
    const rcp = await listMemberBills(db, f, { type: "RCP" });
    expect(rcp.total).toBe(1);
    expect(rcp.byType).toHaveLength(2);
    expect(rcp.rows[0]).toMatchObject({ type: "RCP", number: 1, year: 2026, presentedAt: "2026-02-02T09:54" });
  });

  it("an item numbered inside its main bill carries the main bill's label; a fetched label survives the nightly upsert", async () => {
    const ids = await upsertMembers(db, [member(204407, "Fernanda Melchionna")]);
    const f = ids.get(204407)!;
    const prl = { id: 2651398, type: "PRL", number: 1, year: 0, summary: "Parecer da Relatora", presentedAt: "2026-11-09T10:53", mainBillId: 2636921, mainBillLabel: null };
    const sbr = { id: 2651653, type: "SBR", number: 2, year: 0, summary: "", presentedAt: "2026-11-09T14:47", mainBillId: 2350914, mainBillLabel: "PL 9/2024" };
    const pl = { id: 3, type: "PL", number: 9, year: 2026, summary: "x", presentedAt: "2026-11-01T10:00", mainBillId: 2636921, mainBillLabel: null };
    await upsertBills(db, [prl, sbr, pl]);
    await replaceBillAuthors(db, [prl.id, sbr.id, pl.id], [prl, sbr, pl].map((b) => ({ billId: b.id, memberId: f, firstAuthor: true })));
    // Only year-0 items are asked for; a dated bill attached to another keeps its own label.
    expect(await mainBillsWithoutLabel(db, 10)).toEqual([2636921]);
    await setMainBillLabels(db, [{ mainBillId: 2636921, label: "PL 1761/2025" }]);
    expect(await mainBillsWithoutLabel(db, 10)).toEqual([]);
    await upsertBills(db, [prl]); // the nightly file again, without the label
    const rows = (await listMemberBills(db, f, {})).rows;
    expect(rows.map((r) => [r.id, r.mainBillLabel])).toEqual([[2651653, "PL 9/2024"], [2651398, "PL 1761/2025"], [3, null]]);
    // An id the Câmara doesn't know ("") reads as no label.
    await upsertBills(db, [{ ...prl, mainBillId: 7 }]);
    await setMainBillLabels(db, [{ mainBillId: 7, label: "" }]);
    expect((await listMemberBills(db, f, {})).rows.find((r) => r.id === prl.id)!.mainBillLabel).toBeNull();
  });

  it("listMemberBills: words in the summary (accents aside, terms OR-ed) and the year presented, with the type filter", async () => {
    const ids = await upsertMembers(db, [member(204407, "Fernanda Melchionna"), member(5, "Outra Pessoa")]);
    const f = ids.get(204407)!;
    await upsertBills(db, [
      { id: 1, type: "PL", number: 10, year: 2026, summary: "Dispõe sobre a violência doméstica", presentedAt: "2026-02-10T10:00" },
      { id: 2, type: "PL", number: 11, year: 2025, summary: "Altera a lei da saúde", presentedAt: "2025-11-10T10:00" },
      { id: 3, type: "REQ", number: 1, year: 2026, summary: "Requer informações sobre violência contra a mulher", presentedAt: "2026-03-02T09:54" },
      { id: 4, type: "PL", number: 12, year: 2026, summary: "Violência doméstica, de outra autora", presentedAt: "2026-03-03T09:54" },
    ]);
    await replaceBillAuthors(db, [1, 2, 3, 4], [
      { billId: 1, memberId: f, firstAuthor: true }, { billId: 2, memberId: f, firstAuthor: true }, { billId: 3, memberId: f, firstAuthor: false },
      { billId: 4, memberId: ids.get(5)!, firstAuthor: true },
    ]);
    const idsOf = (r: { rows: { id: number }[] }) => r.rows.map((b) => b.id);
    const all = await listMemberBills(db, f, {});
    expect(all).toMatchObject({ total: 3, all: 3, years: [2026, 2025] });
    const violence = await listMemberBills(db, f, { q: ["violencia"] });
    expect(idsOf(violence)).toEqual([3, 1]);
    // counts by type follow the words and the year (the type filter aside); `all` stays the deputy's whole list
    expect(violence).toMatchObject({ total: 2, all: 3, byType: [{ type: "PL", n: 1 }, { type: "REQ", n: 1 }] });
    expect(idsOf(await listMemberBills(db, f, { q: ["saúde", "mulher"] }))).toEqual([3, 2]);
    expect(idsOf(await listMemberBills(db, f, { year: 2025 }))).toEqual([2]);
    expect(idsOf(await listMemberBills(db, f, { year: 2026, type: "PL" }))).toEqual([1]);
    expect(await listMemberBills(db, f, { q: ["violência"], type: "REQ" })).toMatchObject({ total: 1, rows: [{ id: 3 }] });
    expect(await listMemberBills(db, f, { q: ["o"] })).toMatchObject({ total: 0, all: 3, rows: [], byType: [] });
    expect(await listMemberBills(db, f, { year: 1999 })).toMatchObject({ total: 0, rows: [] });
  });

  it("memberBillIds: word matches best first; `ids` keeps the deputy's that pass the year, in order; listMemberBills with `ids` pages that list", async () => {
    const ids = await upsertMembers(db, [member(204407, "Fernanda Melchionna"), member(5, "Outra Pessoa")]);
    const f = ids.get(204407)!;
    await upsertBills(db, [
      { id: 1, type: "PL", number: 10, year: 2026, summary: "Dispõe sobre a violência doméstica e a violência contra a mulher", presentedAt: "2026-02-10T10:00" },
      { id: 2, type: "PL", number: 11, year: 2025, summary: "Altera a lei da saúde", presentedAt: "2025-11-10T10:00" },
      { id: 3, type: "REQ", number: 1, year: 2026, summary: "Requer informações sobre violência", presentedAt: "2026-03-02T09:54" },
      { id: 4, type: "PL", number: 12, year: 2026, summary: "Violência doméstica, de outra autora", presentedAt: "2026-03-03T09:54" },
    ]);
    await replaceBillAuthors(db, [1, 2, 3, 4], [
      { billId: 1, memberId: f, firstAuthor: true }, { billId: 2, memberId: f, firstAuthor: true }, { billId: 3, memberId: f, firstAuthor: false },
      { billId: 4, memberId: ids.get(5)!, firstAuthor: true },
    ]);
    expect(await memberBillIds(db, f, {})).toEqual([3, 1, 2]);
    // best match first: bill 1 says it twice and holds the typed words together
    expect(await memberBillIds(db, f, { q: ["violência"], phrase: "violência doméstica" })).toEqual([1, 3]);
    expect(await memberBillIds(db, f, { q: ["o"] })).toEqual([]);
    expect(await memberBillIds(db, f, { ids: [2, 4, 1, 99], year: 2026 })).toEqual([1]);
    expect(await memberBillIds(db, f, { ids: [2, 4, 1] })).toEqual([2, 1]);
    expect(await memberBillIds(db, f, { ids: [] })).toEqual([]);
    const listed = await listMemberBills(db, f, { ids: [2, 3, 1], limit: 2, offset: 1 });
    expect(listed).toMatchObject({ total: 3, all: 3, byType: [{ type: "PL", n: 2 }, { type: "REQ", n: 1 }] });
    expect(listed.rows.map((b) => b.id)).toEqual([3, 1]);
    expect(await listMemberBills(db, f, { ids: [2, 3, 1], type: "PL" })).toMatchObject({ total: 2, rows: [{ id: 2 }, { id: 1 }] });
  });

  it("getRollCall groups by party at the vote", async () => {
    const ids = await upsertMembers(db, [member(220576, "Alfredo Gaspar", "PL"), member(204407, "Fernanda Melchionna", "PSOL", "RS"), member(5, "Ana Pimentel", "PT", "MG"), member(6, "Bruno Teste", "PT", "BA")]);
    await upsertRollCalls(db, [{
      id: "2449741-72", date: "2026-03-10", registeredAt: null, description: "Mantido o texto.", yes: 3, no: 1, other: 0,
      billId: 2449741, billLabel: "PL 2942/2024", billSummary: "Ementa",
    }]);
    await replaceVotes(db, "2449741-72", [
      { memberId: ids.get(220576)!, vote: "Não", party: "UNIÃO", uf: "AL" },
      { memberId: ids.get(204407)!, vote: "Sim", party: "PSOL", uf: "RS" },
      { memberId: ids.get(6)!, vote: "Sim", party: "PT", uf: "BA" },
      { memberId: ids.get(5)!, vote: "Artigo 17", party: "PT", uf: "MG" },
    ]);
    await replaceOrientations(db, "2449741-72", [{ bloc: "PT", orientation: "Sim" }, { bloc: "Fdr PT-PCdoB-PV", orientation: "" }]);
    const r = (await getRollCall(db, "2449741-72"))!;
    expect(r.billLabel).toBe("PL 2942/2024");
    expect(r.parties.map((p) => p.party)).toEqual(["PT", "PSOL", "UNIÃO"]);
    expect(r.parties[0]!.deputies.map((d) => d.name)).toEqual(["Ana Pimentel", "Bruno Teste"]);
    expect(r.parties[0]!.counts).toEqual([{ vote: "Sim", n: 1 }, { vote: "Artigo 17", n: 1 }]);
    expect(r.parties[2]!.deputies[0]).toEqual({ externalId: 220576, name: "Alfredo Gaspar", uf: "AL", vote: "Não" });
    expect(r.orientations).toEqual([{ bloc: "Fdr PT-PCdoB-PV", orientation: "", blocName: null }, { bloc: "PT", orientation: "Sim", blocName: null }]);
    expect(await getRollCall(db, "1-1")).toBeNull();
  });

  it("getProfile returns what setProfile stored", async () => {
    const ids = await upsertMembers(db, [member(204407, "Fernanda Melchionna")]);
    const mandates = [{ office: "Vereador(a)", place: "Porto Alegre", uf: "RS", from: 2009, to: 2018, party: "PSOL" }];
    await setProfile(db, ids.get(204407)!, { profession: "Bibliotecária", externalMandates: mandates, fronts: ["F"], positions: [] });
    const { getProfile } = await import("./monitorRecord.ts");
    expect(await getProfile(db, ids.get(204407)!)).toMatchObject({ profession: "Bibliotecária", externalMandates: mandates, fronts: ["F"], positions: [] });
  });
});

describe("blocs", () => {
  it("getRollCall names a cut-short bloc label by the bloc's full name when one stored bloc fits it", async () => {
    await upsertRollCalls(db, [{ id: "1-1", date: "2026-03-10", registeredAt: null, description: "A.", yes: 1, no: 0, other: 0, billId: null, billLabel: null, billSummary: "" }]);
    await replaceOrientations(db, "1-1", [{ bloc: "Bl UniPpPsd...", orientation: "Sim" }, { bloc: "PL", orientation: "Não" }]);
    expect((await getRollCall(db, "1-1"))!.orientations[0]).toEqual({ bloc: "Bl UniPpPsd...", orientation: "Sim", blocName: null });
    const full = "UNIÃO, PP, PSD, REPUBLICANOS, MDB, Federação PSDB CIDADANIA, PODE";
    await replaceBlocs(db, [{ id: 589, legislature: 57, name: full, federation: false, parties: ["MDB", "PP", "PSD", "UNIÃO"] }]);
    expect((await getRollCall(db, "1-1"))!.orientations).toEqual([
      { bloc: "Bl UniPpPsd...", orientation: "Sim", blocName: full },
      { bloc: "PL", orientation: "Não", blocName: null },
    ]);
  });

  it("stores blocs with their members; a bloc listed with none keeps the members last seen; names update", async () => {
    await replaceBlocs(db, [
      { id: 589, legislature: 57, name: "UNIÃO, PP", federation: false, parties: ["UNIÃO", "PP"] },
      { id: 585, legislature: 57, name: "Federação PSDB CIDADANIA", federation: true, parties: ["PSDB", "CIDADANIA", "PSDB"] },
      { id: 590, legislature: 57, name: "AVANTE, SOLIDARIEDADE, PRD", federation: false, parties: [] },
    ]);
    await replaceBlocs(db, [{ id: 589, legislature: 57, name: "UNIÃO, PP, MDB", federation: false, parties: [] }]);
    expect(await listBlocs(db)).toEqual([
      { id: 585, legislature: 57, name: "Federação PSDB CIDADANIA", federation: true, parties: ["CIDADANIA", "PSDB"] },
      { id: 589, legislature: 57, name: "UNIÃO, PP, MDB", federation: false, parties: ["PP", "UNIÃO"] },
      { id: 590, legislature: 57, name: "AVANTE, SOLIDARIEDADE, PRD", federation: false, parties: [] },
    ]);
    await replaceBlocs(db, [{ id: 589, legislature: 57, name: "UNIÃO, PP, MDB", federation: false, parties: ["MDB", "UNIÃO"] }]);
    expect((await listBlocs(db)).find((b) => b.id === 589)?.parties).toEqual(["MDB", "UNIÃO"]);
    await replaceBlocs(db, []);
    expect(await listBlocs(db)).toHaveLength(3);
  });
});
