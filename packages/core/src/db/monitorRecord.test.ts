import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { parlSpeeches } from "./schema.ts";
import { replaceSpeechWindow, upsertMembers, type MemberInput, type SpeechInput } from "./monitor.ts";
import { fillSpeechParties, getHistory, membersNeedingProfile, replaceHistory, setProfile, type HistoryInput } from "./monitorRecord.ts";

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
