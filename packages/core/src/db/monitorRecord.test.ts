import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { parlSpeeches } from "./schema.ts";
import { replaceSpeechWindow, replaceVotes, upsertMembers, upsertRollCalls, type MemberInput, type SpeechInput } from "./monitor.ts";
import {
  fillSpeechParties, getHistory, getPresence, getRollCall, listMemberBills, membersNeedingProfile, replaceBillAuthors, replaceHistory,
  replaceOrientations, replacePresence, setProfile, upsertBills, upsertSessions, type HistoryInput,
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
    "TRUNCATE parl_presence, parl_sessions, parl_bill_authors, parl_bills, parl_orientations, parl_member_history, parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE",
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
    await replacePresence(db, [10, 11, 12], [{ sessionId: 10, memberId: a }, { sessionId: 11, memberId: a }]);
    expect(await getPresence(db, a, 2026)).toEqual({
      sessions: 2, present: 1, missing: [{ id: 12, startsAt: "2026-03-03T14:00", description: "Sessão Deliberativa Ordinária" }],
    });
    expect(await getPresence(db, ids.get(2)!, 2026)).toBeNull();
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
    expect(r.orientations).toEqual([{ bloc: "Fdr PT-PCdoB-PV", orientation: "" }, { bloc: "PT", orientation: "Sim" }]);
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
