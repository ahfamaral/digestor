import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { parlMembers, parlSpeeches, parlVotes } from "./schema.ts";
import { fillSpeechParties, replaceBlocs, replaceHistory, replaceOrientations } from "./monitorRecord.ts";
import {
  countSpeechesInWindow, speechFacets, getMember, listMembers, listMemberSpeeches, listMemberVotes, memberVoteIds, replaceSpeechWindow, replaceVotes, rollCallIdsWithBill,
  searchMembers, searchRollCalls, searchSpeeches, setInOffice, speechesByKeys, speechKeysByWords, filterSpeechKeys, upsertMembers, upsertRollCalls, type MemberInput, type RollCallInput,
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
  await pool.query("TRUNCATE parl_bloc_parties, parl_blocs, parl_presence, parl_sessions, parl_bill_authors, parl_bills, parl_orientations, parl_member_history, parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE");
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

describe("a deputy's vote filters", () => {
  /**
   * Member A votes in 8 roll calls (party at the vote PT, then PSD from July); B votes in two. Guidance: the PT
   * federation (Não, Não, Liberado, empty), none at all, the bloc named "UniPpPsd" (Sim, Não), PSD's own label over its bloc.
   */
  async function setup() {
    const { a, b } = await twoMembers();
    await upsertRollCalls(db, [
      rollCall("1-1", "2026-02-10", { billLabel: "PL 100/2026", billSummary: "Monitoramento de agressores em casos de violência doméstica" }),
      rollCall("1-2", "2026-03-05", { billLabel: "REQ 5/2026", billSummary: "", description: "Aprovado o requerimento de urgência." }),
      rollCall("1-3", "2026-04-20", { billLabel: "PL 200/2026", billSummary: "Reforma tributária", description: "Rejeitado o Requerimento de adiamento." }),
      rollCall("1-4", "2026-05-15", { billLabel: "PL 300/2026", billSummary: "Saúde pública", description: "Aprovada a emenda." }),
      rollCall("1-5", "2026-06-01", { billLabel: null, billId: null, billSummary: "" }),
      rollCall("1-6", "2026-07-01"),
      rollCall("1-7", "2026-07-02"),
      rollCall("1-8", "2026-07-03"),
    ]);
    const vote = (vote: string, party: string) => ({ memberId: a, vote, party, uf: "SP" });
    await replaceVotes(db, "1-1", [vote("Sim", "PT"), { memberId: b, vote: "Sim", party: "PL" }]);
    await replaceVotes(db, "1-2", [vote("Não", "PT")]);
    await replaceVotes(db, "1-3", [vote("Obstrução", "PT")]);
    await replaceVotes(db, "1-4", [vote("Não", "PT"), { memberId: b, vote: "Não", party: "PL" }]);
    await replaceVotes(db, "1-5", [vote("Sim", "PT")]);
    await replaceVotes(db, "1-6", [vote("Abstenção", "PSD")]);
    await replaceVotes(db, "1-7", [vote("Artigo 17", "PSD")]);
    await replaceVotes(db, "1-8", [vote("Não", "PSD")]);
    const fed = "Fdr PT-PCdoB-PV";
    await replaceOrientations(db, "1-1", [{ bloc: fed, orientation: "Não" }, { bloc: "PL", orientation: "Sim" }]);
    await replaceOrientations(db, "1-2", [{ bloc: fed, orientation: "Não" }, { bloc: "Governo", orientation: "Sim" }]);
    await replaceOrientations(db, "1-3", [{ bloc: fed, orientation: "Liberado" }]);
    await replaceOrientations(db, "1-4", [{ bloc: fed, orientation: "" }, { bloc: "Oposição", orientation: "Sim" }]);
    await replaceOrientations(db, "1-6", [{ bloc: "Bl UniPpPsd...", orientation: "Sim" }, { bloc: fed, orientation: "Abstenção" }]);
    await replaceOrientations(db, "1-7", [{ bloc: "Bl UniPpPsd...", orientation: "Não" }]);
    await replaceOrientations(db, "1-8", [{ bloc: "Bl UniPpPsd...", orientation: "Não" }, { bloc: "PSD", orientation: "Sim" }]);
    return { a, b };
  }
  const ids = (r: { rows: { rollCallId: string }[] }) => r.rows.map((x) => x.rollCallId);

  it("no filter: every recorded vote, newest first, with the guidance that applies to the party at the vote", async () => {
    const { a } = await setup();
    const r = await listMemberVotes(db, a, {});
    expect(r.total).toBe(8);
    expect(r.all).toBe(8);
    expect(r.rows.map((x) => [x.rollCallId, x.vote, x.guidance, x.guidanceFrom])).toEqual([
      ["1-8", "Não", "Sim", null], // the party's own label wins over its bloc
      ["1-7", "Artigo 17", "Não", "Bl UniPpPsd..."],
      ["1-6", "Abstenção", "Sim", "Bl UniPpPsd..."], // a bloc whose name shows the party; the PT federation is not PSD's
      ["1-5", "Sim", null, null], // no guidance row
      ["1-4", "Não", null, null], // empty guidance; the opposition's is never the party's
      ["1-3", "Obstrução", "Liberado", "Fdr PT-PCdoB-PV"],
      ["1-2", "Não", "Não", "Fdr PT-PCdoB-PV"], // the government's guidance is never the party's
      ["1-1", "Sim", "Não", "Fdr PT-PCdoB-PV"],
    ]);
  });

  it("each filter alone", async () => {
    const { a } = await setup();
    expect(ids(await listMemberVotes(db, a, { vote: "Sim" }))).toEqual(["1-5", "1-1"]);
    expect(ids(await listMemberVotes(db, a, { vote: "Não" }))).toEqual(["1-8", "1-4", "1-2"]);
    expect(ids(await listMemberVotes(db, a, { vote: "Obstrução" }))).toEqual(["1-3"]);
    expect(ids(await listMemberVotes(db, a, { vote: "Abstenção" }))).toEqual(["1-6"]);
    // "Artigo 17" (the chair) is never matched by a vote filter
    expect(ids(await listMemberVotes(db, a, { vote: "Artigo 17" }))).toEqual([]);
    expect(ids(await listMemberVotes(db, a, { kind: "request" }))).toEqual(["1-3", "1-2"]);
    expect(ids(await listMemberVotes(db, a, { kind: "bill" }))).toEqual(["1-8", "1-7", "1-6", "1-5", "1-4", "1-1"]);
    expect(ids(await listMemberVotes(db, a, { from: "2026-04", to: "2026-06" }))).toEqual(["1-5", "1-4", "1-3"]);
    expect(ids(await listMemberVotes(db, a, { from: "2026-07" }))).toEqual(["1-8", "1-7", "1-6"]);
    expect(ids(await listMemberVotes(db, a, { to: "2026-02" }))).toEqual(["1-1"]);
    // differs: a directed guidance (Sim / Não / Obstrução / Abstenção) and another vote; Liberado, empty, none and the chair never
    expect(ids(await listMemberVotes(db, a, { differsFromGuidance: true }))).toEqual(["1-8", "1-6", "1-1"]);
  });

  it("text: what was voted, the bill's label and its summary, across accents", async () => {
    const { a } = await setup();
    expect(ids(await listMemberVotes(db, a, { q: ["violencia domestica"] }))).toEqual(["1-1"]);
    expect(ids(await listMemberVotes(db, a, { q: ["urgência"] }))).toEqual(["1-2"]);
    expect(ids(await listMemberVotes(db, a, { q: ["PL 300/2026"] }))).toEqual(["1-4"]);
    expect(ids(await listMemberVotes(db, a, { q: ["PL 300"] }))).toEqual(["1-4"]);
    // terms are OR-ed, as in the speech search
    expect(ids(await listMemberVotes(db, a, { q: ["urgência", "saúde"] }))).toEqual(["1-4", "1-2"]);
    // nothing searchable: nothing matches (never everything)
    expect(await listMemberVotes(db, a, { q: ["o"] })).toMatchObject({ total: 0, all: 8, rows: [] });
  });

  it("filters combined, counted and paged; another deputy's votes never show", async () => {
    const { a, b } = await setup();
    expect(ids(await listMemberVotes(db, a, { kind: "bill", differsFromGuidance: true }))).toEqual(["1-8", "1-6", "1-1"]);
    expect(ids(await listMemberVotes(db, a, { vote: "Não", kind: "request" }))).toEqual(["1-2"]);
    expect(ids(await listMemberVotes(db, a, { q: ["reforma tributária"], vote: "Obstrução", from: "2026-04" }))).toEqual(["1-3"]);
    expect(ids(await listMemberVotes(db, a, { q: ["reforma tributária"], differsFromGuidance: true }))).toEqual([]);
    const page = await listMemberVotes(db, a, { differsFromGuidance: true, limit: 2, offset: 2 });
    expect(page).toMatchObject({ total: 3, all: 8 });
    expect(ids(page)).toEqual(["1-1"]);
    const other = await listMemberVotes(db, b, { vote: "Não" });
    expect(other).toMatchObject({ total: 1, all: 2 });
    expect(other.rows[0]).toMatchObject({ rollCallId: "1-4", guidance: null });
  });

  it("counts the votes with a directed guidance (the ones the guidance filter can compare), within the filters and overall", async () => {
    const { a, b } = await setup();
    // A: 1-1, 1-2, 1-6, 1-8 (Liberado, empty, none and the chair's "Artigo 17" can't be compared)
    expect(await listMemberVotes(db, a, {})).toMatchObject({ guided: 4, guidedAll: 4 });
    expect(await listMemberVotes(db, a, { kind: "request" })).toMatchObject({ total: 2, guided: 1, guidedAll: 4 });
    // the guidance filter doesn't narrow its own denominator
    expect(await listMemberVotes(db, a, { kind: "request", differsFromGuidance: true })).toMatchObject({ total: 0, guided: 1, guidedAll: 4 });
    expect(await listMemberVotes(db, a, { from: "2026-04", to: "2026-06" })).toMatchObject({ total: 3, guided: 0, guidedAll: 4 });
    expect(await listMemberVotes(db, b, {})).toMatchObject({ all: 2, guided: 1, guidedAll: 1 });
    // a party no published label names (MDB inside a cut-short bloc): no guidance at all, never "0 differ"
    const c = (await upsertMembers(db, [{ ...member(3, "Deputado MDB"), party: "MDB" }])).get(3)!;
    await replaceVotes(db, "1-6", [{ memberId: a, vote: "Abstenção", party: "PSD" }, { memberId: c, vote: "Não", party: "MDB" }]);
    expect(await listMemberVotes(db, c, { differsFromGuidance: true })).toMatchObject({ total: 0, all: 1, guided: 0, guidedAll: 0 });
  });

  it("memberVoteIds: the filtered roll calls, word matches best first; `ids` keeps only those that pass, in their order", async () => {
    const { a } = await setup();
    // no words: newest first, every filter applied
    expect(await memberVoteIds(db, a, {})).toEqual(["1-8", "1-7", "1-6", "1-5", "1-4", "1-3", "1-2", "1-1"]);
    expect(await memberVoteIds(db, a, { kind: "request" })).toEqual(["1-3", "1-2"]);
    expect(await memberVoteIds(db, a, { differsFromGuidance: true })).toEqual(["1-8", "1-6", "1-1"]);
    // words: the best match first (the summary weighs more than what was voted), not the newest
    expect(await memberVoteIds(db, a, { q: ["urgência", "reforma tributária"] })).toEqual(["1-3", "1-2"]);
    expect(await memberVoteIds(db, a, { q: ["o"] })).toEqual([]);
    // ids (meaning hits): only those that pass the other filters, in the given order; unknown and others' ids dropped
    expect(await memberVoteIds(db, a, { ids: ["1-1", "9-9", "1-3", "1-6"], from: "2026-03" })).toEqual(["1-3", "1-6"]);
    expect(await memberVoteIds(db, a, { ids: [] })).toEqual([]);
  });

  it("listMemberVotes with `ids`: those votes in that order, counted and paged (the text box's fused list)", async () => {
    const { a } = await setup();
    const r = await listMemberVotes(db, a, { ids: ["1-4", "1-1", "1-8", "1-6"], limit: 2, offset: 1 });
    expect(r).toMatchObject({ total: 4, all: 8, guided: 3, guidedAll: 4 });
    expect(ids(r)).toEqual(["1-1", "1-8"]);
    expect(ids(await listMemberVotes(db, a, { ids: ["1-4", "1-1", "1-8", "1-6"], differsFromGuidance: true }))).toEqual(["1-1", "1-8", "1-6"]);
  });

  it("a bloc's published members (Câmara API) give its guidance to parties its cut-short label never shows", async () => {
    const { a } = await setup();
    const c = (await upsertMembers(db, [{ ...member(3, "Deputado MDB"), party: "MDB" }])).get(3)!;
    await replaceVotes(db, "1-6", [{ memberId: a, vote: "Abstenção", party: "PSD" }, { memberId: c, vote: "Não", party: "MDB" }]);
    await replaceVotes(db, "1-7", [{ memberId: a, vote: "Artigo 17", party: "PSD" }, { memberId: c, vote: "Não", party: "MDB" }]);
    // before the fetch: the label "Bl UniPpPsd..." shows no MDB
    expect(await listMemberVotes(db, c, {})).toMatchObject({ guidedAll: 0 });
    const full = "UNIÃO, PP, PSD, REPUBLICANOS, MDB, Federação PSDB CIDADANIA, PODE";
    await replaceBlocs(db, [
      { id: 589, legislature: 57, name: full, federation: false, parties: ["PSDB", "CIDADANIA", "UNIÃO", "PP", "REPUBLICANOS", "PSD", "MDB", "PODE"] },
      { id: 585, legislature: 57, name: "Federação PSDB CIDADANIA", federation: true, parties: ["PSDB", "CIDADANIA"] },
    ]);
    const r = await listMemberVotes(db, c, {});
    expect(r).toMatchObject({ total: 2, guided: 2, guidedAll: 2 });
    expect(r.rows.map((x) => [x.rollCallId, x.vote, x.guidance, x.guidanceFrom])).toEqual([
      ["1-7", "Não", "Não", full],
      ["1-6", "Não", "Sim", full],
    ]);
    expect(ids(await listMemberVotes(db, c, { differsFromGuidance: true }))).toEqual(["1-6"]);
    // the party's own label still wins over its bloc; the source of a bloc guidance is the bloc's full name
    const own = await listMemberVotes(db, a, {});
    expect(own.rows.filter((x) => ["1-8", "1-6"].includes(x.rollCallId)).map((x) => [x.rollCallId, x.guidance, x.guidanceFrom])).toEqual([
      ["1-8", "Sim", null],
      ["1-6", "Sim", full],
    ]);
  });

  it("stored members decide: a party the API doesn't list in the bloc gets no guidance from it, even when the label's letters fit", async () => {
    const { a } = await setup();
    await replaceBlocs(db, [{ id: 589, legislature: 57, name: "UNIÃO, PP, PSD, MDB", federation: false, parties: ["UNIÃO", "PP", "MDB"] }]);
    const r = await listMemberVotes(db, a, { from: "2026-07" });
    expect(r.rows.map((x) => [x.rollCallId, x.guidance, x.guidanceFrom])).toEqual([["1-8", "Sim", null], ["1-7", null, null], ["1-6", null, null]]);
  });

  it("a bloc listed without members (dissolved), or a label no stored bloc fits: the name rule is kept as the fallback", async () => {
    const { a } = await setup();
    await replaceBlocs(db, [{ id: 589, legislature: 57, name: "UNIÃO, PP, PSD, MDB", federation: false, parties: [] }]);
    expect((await listMemberVotes(db, a, { from: "2026-07" })).rows.map((x) => [x.rollCallId, x.guidanceFrom])).toEqual([
      ["1-8", null], ["1-7", "Bl UniPpPsd..."], ["1-6", "Bl UniPpPsd..."],
    ]);
  });

  it("the request rule in SQL is the one the page marks with", async () => {
    const samples = [
      "Rejeitado o Requerimento de adiamento.", "Aprovados os requerimentos.", "Requerimento de urgência", "  mantida a requerimento",
      "Aprovada a Subemenda Substitutiva.", "Requerimentoxyz", "Aprovado o projeto; requerimento prejudicado.",
    ];
    const { REQUEST_DESCRIPTION_PG, isRequestVote } = await import("../monitorVotes.ts");
    for (const d of samples) {
      const r = await db.execute<{ m: boolean }>(sql`select ${d} ~* ${REQUEST_DESCRIPTION_PG} as m`);
      expect([d, r.rows[0]!.m]).toEqual([d, isRequestVote(d, null)]);
    }
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

  it("speechKeysByWords: the word search's ranked keys and total, filtered", async () => {
    await setup();
    const all = await searchSpeeches(db, { terms, limit: 10 });
    const ranked = await speechKeysByWords(db, { terms, limit: 10 });
    expect(ranked.total).toBe(4);
    expect(ranked.keys).toEqual(all.rows.map((r) => r.speechKey));
    expect((await speechKeysByWords(db, { terms, limit: 2 })).keys).toHaveLength(2);
    expect((await speechKeysByWords(db, { terms, filters: { uf: "RS" } })).total).toBe(1);
    expect(await speechKeysByWords(db, { terms: ["e"] })).toEqual({ total: 0, keys: [] });
  });

  it("speechesByKeys: rows in the given order, filters applied, unknown keys skipped", async () => {
    await setup();
    const { rows } = await searchSpeeches(db, { terms, sort: "new", limit: 10 });
    const keys = rows.map((r) => r.speechKey!).reverse();
    const got = await speechesByKeys(db, [...keys, "nope:2026-01-01T00:00:00:abc"]);
    expect(got.map((r) => r.speechKey)).toEqual(keys);
    expect(got[0]).toMatchObject({ member: { name: rows.at(-1)!.member.name }, startsAt: rows.at(-1)!.startsAt });
    expect(names({ rows: await speechesByKeys(db, keys, { party: "UNIÃO" }) })).toEqual(["Alfredo Gaspar@2026-04-29"]);
    expect((await speechesByKeys(db, keys, { inOffice: true })).length).toBe(3);
    expect(await speechesByKeys(db, [])).toEqual([]);
    // highlight: the terms marked in the snippet; without them the snippet is the text's start
    const [h] = await speechesByKeys(db, [keys[0]!], {}, { terms });
    expect(h!.snippet).toContain("\u0001");
    const [plain] = await speechesByKeys(db, [keys[0]!]);
    expect(plain!.snippet).not.toContain("\u0001");
    expect(plain!.snippet).toBe(plain!.text.split(/\s+/).slice(0, 30).join(" "));
  });

  it("speechesByKeys: a row without the words opens with its summary, else its text without the header", async () => {
    const ids = await upsertMembers(db, [member(1, "Fernando Máximo")]);
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-11", [
      speech("2026-03-01T10:00", "O SR. FERNANDO MÁXIMO (UNIÃO - RO. Sem revisão do orador.) - Sr. Presidente, o preço do arroz subiu."),
      speech("2026-03-02T10:00", "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO FERNANDO MÁXIMO (SEM REGISTRO TAQUIGRÁFICO). O Sr. FERNANDO MÁXIMO (UNIÃO-RO) pronuncia o seguinte discurso: Senhor Presidente, a comida está cara."),
      speech("2026-03-03T10:00", "Texto longo.", { summary: "O Deputado criticou a alta dos alimentos." }),
      speech("2026-03-04T10:00", "O feminicídio cresce."),
    ]);
    const { rows } = await db.execute<{ speech_key: string }>(sql`select speech_key from parl_speeches order by starts_at`);
    const got = await speechesByKeys(db, rows.map((r) => r.speech_key), {}, { terms });
    expect(got.slice(0, 3).map((r) => r.snippet)).toEqual([
      "Sr. Presidente, o preço do arroz subiu.",
      "Senhor Presidente, a comida está cara.",
      "O Deputado criticou a alta dos alimentos.",
    ]);
    expect(got[3]!.snippet).toContain("\u0001feminicídio\u0002"); // a word match is highlighted as before
  });

  it("filterSpeechKeys keeps the keys that pass the filters, in order", async () => {
    await setup();
    const { rows } = await searchSpeeches(db, { terms, sort: "new", limit: 10 });
    const keys = rows.map((r) => r.speechKey!);
    expect(await filterSpeechKeys(db, keys, {})).toEqual(keys);
    expect(await filterSpeechKeys(db, [...keys].reverse(), { inOffice: true })).toEqual(
      [...keys].reverse().filter((_, i) => rows[rows.length - 1 - i]!.member.name !== "Ex Deputado"),
    );
    expect(await filterSpeechKeys(db, ["missing"], {})).toEqual([]);
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
