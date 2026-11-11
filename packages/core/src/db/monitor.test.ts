import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { parlMembers, parlSpeeches, parlVotes } from "./schema.ts";
import {
  countSpeechesInWindow, getMember, listMemberSpeeches, listMemberVotes, replaceSpeechWindow, replaceVotes, rollCallIdsWithBill,
  searchMembers, searchRollCalls, searchSpeeches, setInOffice, upsertMembers, upsertRollCalls, type MemberInput, type RollCallInput,
  type SpeechInput,
} from "./monitor.ts";

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE parl_presence, parl_sessions, parl_bill_authors, parl_bills, parl_orientations, parl_member_history, parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE");
  await pool.end();
});

describe("monitor tables", () => {
  it("pt_unaccent matches across accents and plural", async () => {
    const [m] = await db
      .insert(parlMembers)
      .values({ house: "camara", externalId: 204407, name: "Fernanda Melchionna", nameNorm: "fernanda melchionna" })
      .returning();
    await db.insert(parlSpeeches).values({ memberId: m!.id, startsAt: "2026-03-17T18:00", text: "Os feminicídios no Rio Grande do Sul" });
    const r = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from parl_speeches where tsv @@ websearch_to_tsquery('pt_unaccent', 'feminicidio')`,
    );
    expect(r.rows[0]!.n).toBe(1);
  });
});

const member = (externalId: number, name: string): MemberInput => ({
  house: "camara", externalId, name, party: "PSOL", uf: "RS", photoUrl: null,
});
const speech = (startsAt: string, text: string, over: Partial<SpeechInput> = {}): SpeechInput => ({
  startsAt, phase: "Breves Comunicações", kind: "Discurso", summary: "", text, keywords: "", ...over,
});
const rollCall = (id: string, date: string, over: Partial<RollCallInput> = {}): RollCallInput => ({
  id, date, registeredAt: null, description: "Aprovado o projeto.", yes: 408, no: 13, other: 2, billId: 2400000,
  billLabel: "PL 2942/2024", billSummary: "", ...over,
});

async function twoMembers() {
  const ids = await upsertMembers(db, [member(204407, "Fernanda Melchionna"), member(1, "Fernando Máximo")]);
  return { a: ids.get(204407)!, b: ids.get(1)! };
}

describe("members", () => {
  it("searchMembers finds Melchionna without accents or case", async () => {
    await twoMembers();
    const rows = await searchMembers(db, "melchion");
    expect(rows.map((r) => r.name)).toEqual(["Fernanda Melchionna"]);
    expect((await searchMembers(db, "MAXIMO")).map((r) => r.name)).toEqual(["Fernando Máximo"]);
  });

  it("upsertMembers updates in place and setInOffice flips the rest of the house", async () => {
    const { a } = await twoMembers();
    const again = await upsertMembers(db, [{ ...member(204407, "Fernanda Melchionna"), party: "PSOL", uf: "RS" }]);
    expect(again.get(204407)).toBe(a);
    await setInOffice(db, "camara", [204407]);
    expect((await getMember(db, "camara", 204407))?.inOffice).toBe(true);
    expect((await getMember(db, "camara", 1))?.inOffice).toBe(false);
    expect(await getMember(db, "camara", 999)).toBeNull();
  });
});

describe("speeches", () => {
  it("searchSpeeches ORs the terms and filters by member", async () => {
    const { a, b } = await twoMembers();
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [
      speech("2026-03-17T18:00", "O feminicídio no RS"), speech("2026-04-01T10:00", "O orçamento da saúde"),
    ]);
    await replaceSpeechWindow(db, b, "2026-02-01", "2026-11-11", [speech("2026-05-01T10:00", "A violência contra a mulher")]);
    const all = await searchSpeeches(db, { terms: ["feminicídio", "violência contra a mulher"] });
    expect(all.total).toBe(2);
    const mine = await searchSpeeches(db, { terms: ["feminicídio", "violência contra a mulher"], memberId: a });
    expect(mine.total).toBe(1);
    expect(mine.rows[0]!.member.name).toBe("Fernanda Melchionna");
    expect(mine.rows[0]!.snippet).toContain("\u0001");
  });

  it("empty tsquery", async () => {
    const { a } = await twoMembers();
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [speech("2026-03-17T18:00", "O feminicídio no RS")]);
    expect(await searchSpeeches(db, { terms: ["o"] })).toEqual({ total: 0, rows: [] });
    expect(await searchSpeeches(db, { terms: ["!!!"] })).toEqual({ total: 0, rows: [] });
    expect(await searchSpeeches(db, { terms: ["  "] })).toEqual({ total: 0, rows: [] });
    expect(await searchSpeeches(db, { terms: [] })).toEqual({ total: 0, rows: [] });
  });

  it("replaces a window", async () => {
    const { a } = await twoMembers();
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [
      speech("2026-11-09T10:00", "um"), speech("2026-11-09T10:04", "dois"), speech("2026-10-01T10:00", "outubro"),
    ]);
    const r = await replaceSpeechWindow(db, a, "2026-11-04", "2026-11-11", [speech("2026-11-09T10:00", "um, agora com texto")]);
    expect(r).toEqual({ deleted: 2, inserted: 1 });
    expect(await countSpeechesInWindow(db, a, "2026-11-04", "2026-11-11")).toBe(1);
    const list = await listMemberSpeeches(db, a, {});
    expect(list.total).toBe(2);
    expect(list.rows.map((x) => x.text)).toEqual(["um, agora com texto", "outubro"]);
    expect(list.rows[0]!.startsAt).toBe("2026-11-09T10:00");
  });

  it("a speech keeps its key across a window replace; duplicates get distinct keys", async () => {
    const { a } = await twoMembers();
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [speech("2026-03-17T18:00", "O feminicídio no RS")]);
    const k1 = (await db.select().from(parlSpeeches)).map((r) => r.speechKey);
    expect(k1[0]).toMatch(/^204407:2026-03-17T18:00:[0-9a-f]{10}$/);
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [
      speech("2026-03-17T18:00", "O feminicídio no RS"), speech("2026-04-01T10:00", "outro"),
    ]);
    const k2 = (await db.select().from(parlSpeeches)).map((r) => r.speechKey);
    expect(k2).toContain(k1[0]);
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [speech("2026-05-01T10:00", "igual"), speech("2026-05-01T10:00", "igual")]);
    const k3 = (await db.select().from(parlSpeeches)).map((r) => r.speechKey!).sort();
    expect(k3).toHaveLength(2);
    expect(k3[1]).toBe(`${k3[0]}:2`);
  });
});

describe("roll calls", () => {
  it("searchRollCalls skips symbolic votes", async () => {
    const summary = "monitoramento eletrônico para agressores em casos de violência doméstica";
    await upsertRollCalls(db, [
      rollCall("2449741-72", "2026-03-18", { billSummary: summary }),
      rollCall("1-1", "2026-03-19", { billSummary: summary, yes: 0, no: 0, other: 0 }),
    ]);
    const hits = await searchRollCalls(db, { terms: ["violência doméstica"] });
    expect(hits.map((h) => h.id)).toEqual(["2449741-72"]);
    expect(hits[0]!.snippet).toContain("\u0001");
    expect(hits[0]).not.toHaveProperty("vote");
    expect(await searchRollCalls(db, { terms: ["o"] })).toEqual([]);
  });

  it("listMemberVotes lists recorded votes only, newest first", async () => {
    const { a, b } = await twoMembers();
    await upsertRollCalls(db, [
      rollCall("2449741-72", "2026-03-18"), rollCall("2462009-57", "2026-05-20", { billLabel: "PL 3880/2024", billId: null }),
      rollCall("3-3", "2026-06-01"),
    ]);
    await replaceVotes(db, "2449741-72", [{ memberId: a, vote: "Sim" }, { memberId: b, vote: "Não" }]);
    await replaceVotes(db, "2462009-57", [{ memberId: a, vote: "Não" }]);
    await replaceVotes(db, "3-3", [{ memberId: b, vote: "Obstrução" }]);
    const v = await listMemberVotes(db, a, {});
    expect(v.total).toBe(2);
    expect(v.rows.map((r) => [r.rollCallId, r.vote, r.billLabel])).toEqual([
      ["2462009-57", "Não", "PL 3880/2024"], ["2449741-72", "Sim", "PL 2942/2024"],
    ]);
    await replaceVotes(db, "2449741-72", [{ memberId: b, vote: "Sim" }]);
    expect((await listMemberVotes(db, a, {})).total).toBe(1);
    expect(await rollCallIdsWithBill(db, ["2449741-72", "2462009-57", "nope"])).toEqual(new Set(["2449741-72"]));
  });

  it("replaceVotes stores the party at the vote", async () => {
    const { a, b } = await twoMembers();
    await upsertRollCalls(db, [rollCall("2449741-72", "2026-03-18")]);
    await replaceVotes(db, "2449741-72", [{ memberId: a, vote: "Sim", party: "UNIÃO", uf: "AL" }, { memberId: b, vote: "Não" }]);
    const rows = await db.select().from(parlVotes).orderBy(parlVotes.memberId);
    expect(rows.map((r) => [r.party, r.uf])).toEqual([["UNIÃO", "AL"], [null, null]]);
  });

  it("upsertRollCalls updates in place", async () => {
    await upsertRollCalls(db, [rollCall("2449741-72", "2026-03-18")]);
    await upsertRollCalls(db, [rollCall("2449741-72", "2026-03-18", { yes: 410, billSummary: "violência doméstica" })]);
    const hits = await searchRollCalls(db, { terms: ["violência doméstica"] });
    expect(hits.map((h) => h.yes)).toEqual([410]);
  });
});
