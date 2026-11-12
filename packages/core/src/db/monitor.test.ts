import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { parlMembers, parlSpeeches, parlVotes } from "./schema.ts";
import { fillSpeechParties, replaceHistory } from "./monitorRecord.ts";
import {
  countSpeechesInWindow, speechFacets, getMember, listMembers, listMemberSpeeches, listMemberVotes, replaceSpeechWindow, replaceVotes, rollCallIdsWithBill,
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

  it("listMembers: the whole house, alphabetical with accents and case ignored", async () => {
    await upsertMembers(db, [member(3, "Zé Silva"), member(1, "Átila Lira"), member(2, "ana Paula"), member(4, "Bia Kicis")]);
    await setInOffice(db, "camara", [1, 2, 3]);
    const rows = await listMembers(db, "camara");
    expect(rows.map((r) => r.name)).toEqual(["ana Paula", "Átila Lira", "Bia Kicis", "Zé Silva"]);
    expect(rows.find((r) => r.name === "Bia Kicis")!.inOffice).toBe(false);
  });

  it("searchMembers: a name starting with the text first, then a word starting with it, then the text inside a word", async () => {
    await upsertMembers(db, [member(1, "Ana Vermelho"), member(2, "João Melo"), member(3, "Mel Souza")]);
    expect((await searchMembers(db, "mel")).map((r) => r.name)).toEqual(["Mel Souza", "João Melo", "Ana Vermelho"]);
    await upsertMembers(db, [member(4, "Vermel"), member(5, "Carlos Augusto Melo da Silva Santos Junior")]);
    expect((await searchMembers(db, "mel")).map((r) => r.name)).toEqual([
      "Mel Souza", "João Melo", "Carlos Augusto Melo da Silva Santos Junior", "Vermel", "Ana Vermelho",
    ]);
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

  it("stores the official text link and the attached-file flag; lists and search return them", async () => {
    const { a } = await twoMembers();
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [
      { ...speech("2026-10-13T13:55", "DISCURSO NA ÍNTEGRA (SEM REGISTRO TAQUIGRÁFICO)."), urlText: "https://imagem.camara.gov.br/x", textFile: true },
      speech("2026-10-14T10:00", "feminicídio"),
    ]);
    const list = await listMemberSpeeches(db, a, {});
    expect(list.rows.map((r) => [r.urlText, r.textFile])).toEqual([[null, false], ["https://imagem.camara.gov.br/x", true]]);
    const hit = await searchSpeeches(db, { terms: ["taquigráfico"] });
    expect(hit.rows[0]).toMatchObject({ urlText: "https://imagem.camara.gov.br/x", textFile: true });
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
  it("`phrase`: speeches and roll calls holding the typed words together rank first", async () => {
    const { a } = await twoMembers();
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [
      speech("2026-03-01T10:00", "A reforma do sistema tributário, reforma e outra reforma; muita coisa tributária e tributária e tributária."),
      speech("2026-03-02T10:00", "Falo da reforma tributária."),
    ]);
    const terms = ["reforma tributária", '"sistema tributário"'];
    const plain = await searchSpeeches(db, { terms });
    expect(plain.rows[0]!.text).toMatch(/^A reforma do sistema/);
    const boosted = await searchSpeeches(db, { terms, phrase: "reforma tributária" });
    expect(boosted.total).toBe(2);
    expect(boosted.rows[0]!.text).toBe("Falo da reforma tributária.");
    // a long speech repeating the terms scores far above 1: the typed words together must still come first
    const dense = Array.from({ length: 40 }, () => "reforma do sistema tributário; tributária e outra reforma").join(". ");
    await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [
      speech("2026-03-01T10:00", dense, { summary: "Reforma do sistema tributário.", keywords: "Sistema tributário" }),
      speech("2026-03-02T10:00", "Falo da reforma tributária."),
    ]);
    const heavy = await searchSpeeches(db, { terms, phrase: "reforma tributária" });
    expect(heavy.rows[0]!.text).toBe("Falo da reforma tributária.");
    await upsertRollCalls(db, [
      rollCall("1-1", "2026-03-01", { description: "Reforma do sistema tributário: reforma e outra reforma; muita coisa tributária, tributária." }),
      rollCall("1-2", "2026-03-02", { description: "Aprovada a reforma tributária." }),
    ]);
    expect((await searchRollCalls(db, { terms, phrase: "reforma tributária" })).rows[0]!.id).toBe("1-2");
  });

  it("searchRollCalls skips symbolic votes", async () => {
    const summary = "monitoramento eletrônico para agressores em casos de violência doméstica";
    await upsertRollCalls(db, [
      rollCall("2449741-72", "2026-03-18", { billSummary: summary }),
      rollCall("1-1", "2026-03-19", { billSummary: summary, yes: 0, no: 0, other: 0 }),
    ]);
    const hits = (await searchRollCalls(db, { terms: ["violência doméstica"] })).rows;
    expect(hits.map((h) => h.id)).toEqual(["2449741-72"]);
    expect(hits[0]!.snippet).toContain("\u0001");
    expect(hits[0]).not.toHaveProperty("vote");
    expect(await searchRollCalls(db, { terms: ["o"] })).toEqual({ total: 0, rows: [] });
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
    const hits = (await searchRollCalls(db, { terms: ["violência doméstica"] })).rows;
    expect(hits.map((h) => h.yes)).toEqual([410]);
  });
});

describe("search filters", () => {
  async function setup() {
    const ids = await upsertMembers(db, [
      { ...member(220576, "Alfredo Gaspar"), party: "PL", uf: "AL" }, member(204407, "Fernanda Melchionna"), { ...member(9, "Ex Deputado"), party: "PT", uf: "SP" },
    ]);
    const g = ids.get(220576)!, f = ids.get(204407)!, x = ids.get(9)!;
    await replaceHistory(db, g, [
      { at: "2023-02-01T12:05", party: "UNIÃO", uf: "AL", status: "Exercício", description: "Posse" },
      { at: "2026-04-29T22:10", party: "PL", uf: "AL", status: "Exercício", description: "Alteração de partido" },
    ]);
    await replaceHistory(db, f, [{ at: "2023-02-01T12:05", party: "PSOL", uf: "RS", status: "Exercício", description: "Posse" }]);
    await replaceHistory(db, x, [{ at: "2023-02-01T12:05", party: "PT", uf: "SP", status: "Exercício", description: "Posse" }]);
    await replaceSpeechWindow(db, g, "2026-02-01", "2026-11-11", [
      speech("2026-04-29T18:00", "feminicídio feminicídio feminicídio em Alagoas"), speech("2026-05-01T10:00", "o feminicídio"),
    ]);
    await replaceSpeechWindow(db, f, "2026-02-01", "2026-11-11", [
      speech("2026-03-17T18:00", "O feminicídio no RS", { phase: "Grande Expediente" }),
      speech("2026-06-02T10:00", "Eu, Fernanda Melchionna, falo do orçamento"),
    ]);
    await replaceSpeechWindow(db, x, "2026-02-01", "2026-11-11", [
      speech("2026-07-01T10:00", "A deputada Fernanda Melchionna defendeu as mulheres; feminicídio"),
    ]);
    await setInOffice(db, "camara", [220576, 204407]);
    await fillSpeechParties(db);
    return { g, f, x };
  }
  const terms = ["feminicídio"];
  const names = (r: { rows: { member: { name: string }; startsAt: string }[] }) => r.rows.map((s) => `${s.member.name}@${s.startsAt.slice(0, 10)}`);

  it("searchSpeeches filters by dates, party on the day, state, phase and in office", async () => {
    await setup();
    const one = await searchSpeeches(db, { terms, filters: { party: "UNIÃO" } });
    expect(names(one)).toEqual(["Alfredo Gaspar@2026-04-29"]);
    expect(one.rows[0]!.partyThen).toBe("UNIÃO");
    expect(one.rows[0]!.member.party).toBe("PL");
    expect(names(await searchSpeeches(db, { terms, filters: { party: "PL" } }))).toEqual(["Alfredo Gaspar@2026-05-01"]);
    expect((await searchSpeeches(db, { terms, filters: { uf: "RS" } })).total).toBe(1);
    expect((await searchSpeeches(db, { terms, filters: { from: "2026-04-29", to: "2026-05-01" } })).total).toBe(2);
    expect(names(await searchSpeeches(db, { terms, filters: { phase: "Grande Expediente" } }))).toEqual(["Fernanda Melchionna@2026-03-17"]);
    expect((await searchSpeeches(db, { terms })).total).toBe(4);
    expect((await searchSpeeches(db, { terms, filters: { inOffice: true } })).total).toBe(3);
  });

  it("searchSpeeches sorts by best match or newest", async () => {
    const { g } = await setup();
    expect(names(await searchSpeeches(db, { terms, memberId: g }))).toEqual(["Alfredo Gaspar@2026-04-29", "Alfredo Gaspar@2026-05-01"]);
    expect(names(await searchSpeeches(db, { terms, memberId: g, sort: "new" }))).toEqual(["Alfredo Gaspar@2026-05-01", "Alfredo Gaspar@2026-04-29"]);
  });

  it("mentions: others' speeches naming the deputy, topic optional, name highlighted", async () => {
    const { f } = await setup();
    const m = await searchSpeeches(db, { terms: [], mentionOf: { memberId: f, name: "Fernanda Melchionna" } });
    expect(names(m)).toEqual(["Ex Deputado@2026-07-01"]);
    expect(m.rows[0]!.snippet).toContain("\u0001Fernanda");
    expect((await searchSpeeches(db, { terms, mentionOf: { memberId: f, name: "Fernanda Melchionna" } })).total).toBe(1);
    expect((await searchSpeeches(db, { terms: ["orçamento"], mentionOf: { memberId: f, name: "Fernanda Melchionna" } })).total).toBe(0);
  });

  it("mention names never break the query", async () => {
    const { f } = await setup();
    for (const name of ["Paulão", "Dr. Zacharias Calil", "D'Ávila", "Coronel Chrisóstomo-Silva", "!!!", "o"]) {
      await expect(searchSpeeches(db, { terms: [], mentionOf: { memberId: f, name } })).resolves.toBeTruthy();
    }
  });

  it("speechFacets lists values alphabetically", async () => {
    await setup();
    const f = await speechFacets(db);
    expect(f.parties).toEqual(["PL", "PSOL", "PT", "UNIÃO"]);
    expect(f.ufs).toEqual(["AL", "RS", "SP"]);
    expect(f.phases).toEqual(["Breves Comunicações", "Grande Expediente"]);
  });

  it("listMemberSpeeches narrows by dates and phase", async () => {
    const { f } = await setup();
    expect((await listMemberSpeeches(db, f, { phase: "Grande Expediente" })).total).toBe(1);
    expect((await listMemberSpeeches(db, f, { from: "2026-06-01", to: "2026-06-30" })).total).toBe(1);
  });

  it("searchRollCalls pages, filters by date and sorts", async () => {
    const summary = "violência doméstica";
    await upsertRollCalls(db, [
      rollCall("1-1", "2026-03-18", { billSummary: `${summary} ${summary} ${summary}` }),
      rollCall("2-2", "2026-05-20", { billSummary: summary }),
      rollCall("3-3", "2026-06-01", { billSummary: summary }),
    ]);
    const page = await searchRollCalls(db, { terms: [summary], limit: 2 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]!.id).toBe("1-1");
    expect((await searchRollCalls(db, { terms: [summary], from: "2026-05-01" })).total).toBe(2);
    expect((await searchRollCalls(db, { terms: [summary], sort: "new" })).rows.map((r) => r.id)).toEqual(["3-3", "2-2", "1-1"]);
  });
});
