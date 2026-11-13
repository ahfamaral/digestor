import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb, replaceBillAuthors, replaceSpeechWindow, replaceVotes, upsertBills, upsertMembers, upsertRollCalls, type Db,
} from "@digestor/core/server";
import { parseLanding, type LandingParams } from "./params";
import { billMeaning, hybridBills, hybridVotes, runSearch, voteMeaning, type RecordSemantic, type TranslateResult } from "./search";

/** Landing parameters with a raw query (runSearch cleans it). */
const L = (q: string, rest: Partial<LandingParams> = {}): LandingParams => ({ ...parseLanding({}), ...rest, q });

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  await db.execute("TRUNCATE parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE");
});

describe("runSearch", () => {
  it("caps the query at 200 characters", async () => {
    const translate = vi.fn(async (q: string): Promise<TranslateResult> => ({ terms: [q], translated: false, failed: false }));
    const r = await runSearch(db, L("x".repeat(300)), translate);
    expect(translate).toHaveBeenCalledWith("x".repeat(200));
    expect(r.q).toHaveLength(200);
  });

  it("an empty query returns empty groups without touching the database", async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as Db;
    const r = await runSearch(noDb, L("   "));
    expect(r).toMatchObject({ q: "", terms: [], speeches: { total: 0, rows: [] }, rollCalls: { total: 0, rows: [] } });
  });

  it("finds a deputy by name and speeches by the translated terms", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS", photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(204407)!, "2026-02-01", "2026-11-11", [
      { startsAt: "2026-03-17T18:00", phase: null, kind: null, summary: "", text: "O feminicídio no RS", keywords: "" },
    ]);
    const r = await runSearch(db, L("femicide"), async () => ({ terms: ["feminicídio", "violência contra a mulher"], translated: true, failed: false }));
    expect(r.terms).toEqual(["feminicídio", "violência contra a mulher"]);
    expect(r.translatedFrom).toBe("femicide");
    expect(r.speeches!.total).toBe(1);
  });

  it("without a translator, or when it fails, searches the words as typed", async () => {
    expect((await runSearch(db, L("feminicídio"))).terms).toEqual(["feminicídio"]);
    const failed = await runSearch(db, L("femicide"), async (q) => ({ terms: [q], translated: false, failed: true }));
    expect(failed).toMatchObject({ terms: ["femicide"], translatedFrom: null, notice: "translationFailed" });
  });

  it("searches translated multi-word terms as phrases, not loose words", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "A", party: null, uf: null, photoUrl: null }]);
    const speech = (startsAt: string, text: string) => ({ startsAt, phase: null, kind: null, summary: "", text, keywords: "" });
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-11", [
      speech("2026-03-01T10:00", "Combater a violência contra a mulher é urgente."),
      speech("2026-03-02T10:00", "A violência no trânsito é contra a lei; a mulher do prefeito falou."),
    ]);
    const r = await runSearch(db, L("violence against women"), async () => ({ terms: ["violência contra a mulher"], translated: true, failed: false }));
    expect(r.terms).toEqual(["violência contra a mulher"]);
    expect(r.speeches!.total).toBe(1);
    // what the person typed keeps its own search syntax
    expect((await runSearch(db, L("violência mulher"))).speeches!.total).toBe(2);
  });

  it("exact: no translation, only the words as typed", async () => {
    const translate = vi.fn(async (): Promise<TranslateResult> => ({ terms: ["x"], translated: true, failed: false }));
    const r = await runSearch(db, L("reforma tributária", { exact: true }), translate);
    expect(translate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ terms: ["reforma tributária"], translatedFrom: null, exact: true });
  });

  it("speeches holding the typed words together come first under Best match", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "A", party: null, uf: null, photoUrl: null }]);
    const speech = (startsAt: string, text: string) => ({ startsAt, phase: null, kind: null, summary: "", text, keywords: "" });
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-11", [
      speech("2026-03-01T10:00", "A reforma do sistema tributário, reforma e outra reforma; muita coisa tributária e tributária."),
      speech("2026-03-02T10:00", "Falo da reforma tributária."),
    ]);
    const r = await runSearch(db, L("reforma tributária"), async () => ({ terms: ["reforma tributária", "sistema tributário"], translated: false, failed: false }));
    expect(r.speeches!.rows[0]!.text).toBe("Falo da reforma tributária.");
  });

  it("strips control characters (a NUL would make Postgres throw)", async () => {
    const r = await runSearch(db, L("femi\u0000nicídio\u0007"));
    expect(r.q).toBe("femi nicídio");
  });

  it("a group not shown is null; speech filters and paging apply", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "A", party: "PSOL", uf: "RS", photoUrl: null }]);
    const speech = (startsAt: string) => ({ startsAt, phase: null, kind: null, summary: "", text: "O feminicídio no RS", keywords: "" });
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-11", [speech("2026-03-01T10:00"), speech("2026-07-01T10:00")]);
    const onlyRollCalls = await runSearch(db, L("feminicídio", { show: { speeches: false, rollCalls: true } }));
    expect(onlyRollCalls.speeches).toBeNull();
    expect(onlyRollCalls.rollCalls).toEqual({ total: 0, rows: [] });
    expect((await runSearch(db, L("feminicídio", { from: "2026-06-01" }))).speeches!.total).toBe(1);
    expect((await runSearch(db, L("feminicídio", { p: 1 }))).speeches!.rows).toHaveLength(0);
    expect((await runSearch(db, L("feminicídio", { sort: "new" }))).speeches!.rows[0]!.startsAt).toBe("2026-07-01T10:00");
  });
});

describe("runSearch with search by meaning (hybrid)", () => {
  /** Speeches of two deputies; returns their keys by a short tag. */
  async function seed() {
    const ids = await upsertMembers(db, [
      { house: "camara", externalId: 1, name: "Ana", party: "PSOL", uf: "RS", photoUrl: null },
      { house: "camara", externalId: 2, name: "Bia", party: "PL", uf: "SP", photoUrl: null },
    ]);
    const speech = (startsAt: string, text: string) => ({ startsAt, phase: null, kind: null, summary: "", text, keywords: "" });
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-11", [
      speech("2026-03-01T10:00", "A inflação dos alimentos pesa no bolso."), // both
      speech("2026-03-02T10:00", "O preço da comida subiu de novo."), // words only
      speech("2026-03-03T10:00", "O arroz e o feijão estão caros no mercado."), // meaning only
    ]);
    await replaceSpeechWindow(db, ids.get(2)!, "2026-02-01", "2026-11-11", [
      speech("2026-03-04T10:00", "A cesta básica ficou mais cara em São Paulo."), // meaning only, other deputy
    ]);
    const { rows } = await db.execute<{ speech_key: string; text: string }>("select speech_key, text from parl_speeches");
    const key = (start: string) => rows.find((r) => r.text.startsWith(start))!.speech_key;
    return { both: key("A inflação"), words: key("O preço"), rice: key("O arroz"), basket: key("A cesta") };
  }
  const translate = async (): Promise<TranslateResult> => ({ terms: ["preço da comida", "inflação dos alimentos"], translated: false, failed: false });
  const words = (r: Awaited<ReturnType<typeof runSearch>>) => r.speeches!.rows.map((s) => s.speechKey);

  it("fuses word and meaning results; rows found only by meaning are marked", async () => {
    const k = await seed();
    const semantic = vi.fn(async () => ({ keys: [k.rice, k.both, k.basket], ok: true }));
    const r = await runSearch(db, L("preço da comida"), translate, semantic);
    expect(semantic).toHaveBeenCalledWith("preço da comida");
    expect(r.meaning).toBe("used");
    expect(r.speeches!.total).toBe(4);
    expect(words(r)[0]).toBe(k.both); // in both lists
    expect(new Set(words(r))).toEqual(new Set([k.both, k.words, k.rice, k.basket]));
    const marked = Object.fromEntries(r.speeches!.rows.map((s) => [s.speechKey, s.byMeaning]));
    expect(marked).toEqual({ [k.both]: false, [k.words]: false, [k.rice]: true, [k.basket]: true });
    // counted apart: they may not be about the topic, so they never count as matches
    expect(r.speeches!.meaningOnly).toBe(2);
    // word matches are highlighted; a meaning-only row shows its opening words
    expect(r.speeches!.rows.find((s) => s.speechKey === k.words)!.snippet).toContain("\u0001");
    expect(r.speeches!.rows.find((s) => s.speechKey === k.rice)!.snippet).toBe("O arroz e o feijão estão caros no mercado.");
  });

  it("filters apply to meaning hits too", async () => {
    const k = await seed();
    const semantic = async () => ({ keys: [k.rice, k.basket], ok: true });
    const r = await runSearch(db, L("preço da comida", { from: "2026-03-02", to: "2026-03-03" }), translate, semantic);
    expect(new Set(words(r))).toEqual(new Set([k.words, k.rice]));
    expect(r.speeches!.total).toBe(2);
    expect(r.speeches!.meaningOnly).toBe(1);
  });

  it("pages over the fused list without repeats or gaps", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "Ana", party: null, uf: null, photoUrl: null }]);
    const speech = (i: number, text: string) => ({
      startsAt: `2026-03-${String(1 + (i % 28)).padStart(2, "0")}T${String(10 + Math.floor(i / 28)).padStart(2, "0")}:00`,
      phase: null, kind: null, summary: "", text, keywords: "",
    });
    await replaceSpeechWindow(db, ids.get(1)!, "2026-02-01", "2026-11-11", [
      ...Array.from({ length: 25 }, (_, i) => speech(i, `A saúde pública ${i}.`)),
      ...Array.from({ length: 10 }, (_, i) => speech(30 + i, `Hospitais sem médicos ${i}.`)),
    ]);
    const all = await db.execute<{ speech_key: string; text: string }>("select speech_key, text from parl_speeches order by id");
    const hospitals = all.rows.filter((r) => r.text.startsWith("Hospitais")).map((r) => r.speech_key);
    const semantic = async () => ({ keys: hospitals, ok: true });
    const t = async (): Promise<TranslateResult> => ({ terms: ["saúde"], translated: false, failed: false });
    const p0 = await runSearch(db, L("saúde", { p: 0 }), t, semantic);
    const p1 = await runSearch(db, L("saúde", { p: 1 }), t, semantic);
    expect(p0.speeches!.total).toBe(35);
    expect(p0.speeches!.rows).toHaveLength(20);
    expect(p1.speeches!.rows).toHaveLength(15);
    const seen = [...words(p0), ...words(p1)];
    expect(new Set(seen).size).toBe(35);
    expect(words(await runSearch(db, L("saúde", { p: 1 }), t, semantic))).toEqual(words(p1));
  });

  it("worker down or index empty: word results only, and says so", async () => {
    const k = await seed();
    const r = await runSearch(db, L("preço da comida"), translate, async () => ({ keys: [], ok: false }));
    expect(r.meaning).toBe("unavailable");
    expect(new Set(words(r))).toEqual(new Set([k.both, k.words]));
    expect(r.speeches!.rows.every((s) => !s.byMeaning)).toBe(true);
    expect(r.speeches!.meaningOnly ?? 0).toBe(0);
  });

  it("no word match: every row is close in meaning, none counted as a match", async () => {
    const k = await seed();
    const none = async (): Promise<TranslateResult> => ({ terms: ["xkcd qwerty zzz"], translated: false, failed: false });
    const r = await runSearch(db, L("xkcd qwerty zzz"), none, async () => ({ keys: [k.rice, k.basket], ok: true }));
    expect(r.speeches!.total).toBe(2);
    expect(r.speeches!.meaningOnly).toBe(2);
    expect(r.speeches!.rows.every((s) => s.byMeaning)).toBe(true);
  });

  it("exact, newest first and roll-call-only searches stay word-only", async () => {
    await seed();
    const semantic = vi.fn(async () => ({ keys: [], ok: true }));
    expect((await runSearch(db, L("preço da comida", { exact: true }), translate, semantic)).meaning).toBe("off");
    expect((await runSearch(db, L("preço da comida", { sort: "new" }), translate, semantic)).meaning).toBe("off");
    expect((await runSearch(db, L("preço da comida", { show: { speeches: false, rollCalls: true } }), translate, semantic)).meaning).toBe("off");
    expect((await runSearch(db, L("preço da comida"), translate)).meaning).toBe("off");
    expect(semantic).not.toHaveBeenCalled();
  });
});

describe("a deputy's vote and bill text boxes with search by meaning", () => {
  beforeEach(async () => {
    await db.execute("TRUNCATE parl_bill_authors, parl_bills RESTART IDENTITY CASCADE");
  });
  async function setup() {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "A", party: "PT", uf: "SP", photoUrl: null }]);
    const a = ids.get(1)!;
    const rc = (id: string, date: string, billSummary: string, description = "Aprovado o projeto.") => ({
      id, date, registeredAt: null, description, yes: 1, no: 1, other: 0, billId: null, billLabel: "PL 1/2026", billSummary,
    });
    await upsertRollCalls(db, [
      rc("1-1", "2026-03-01", "Dispõe sobre a aposentadoria rural"),
      rc("2-1", "2026-03-02", "Altera o regime de previdência dos servidores"),
      rc("3-1", "2026-03-03", "Cria a universidade do esporte"),
      rc("4-1", "2026-04-01", "Benefício previdenciário para pescadores"),
    ]);
    for (const [id, vote] of [["1-1", "Sim"], ["2-1", "Não"], ["3-1", "Sim"], ["4-1", "Sim"]] as const) {
      await replaceVotes(db, id, [{ memberId: a, vote, party: "PT" }]);
    }
    await upsertBills(db, [
      { id: 10, type: "PL", number: 10, year: 2026, summary: "Dispõe sobre a aposentadoria especial", presentedAt: "2026-03-01T10:00" },
      { id: 11, type: "REQ", number: 11, year: 2026, summary: "Requer informações sobre a previdência", presentedAt: "2026-03-02T10:00" },
      { id: 12, type: "PL", number: 12, year: 2026, summary: "Institui o dia do esporte", presentedAt: "2026-03-03T10:00" },
    ]);
    await replaceBillAuthors(db, [10, 11, 12], [10, 11, 12].map((billId) => ({ billId, memberId: a, firstAuthor: true })));
    return a;
  }
  const page = { limit: 20, offset: 0 };

  it("votes: the words first-fused with the closest meaning hits (the deputy's filtered votes only), marked by meaning", async () => {
    const a = await setup();
    const semantic = vi.fn<RecordSemantic>(async (_kind, _q, ids) => ({
      ok: true, hits: [{ id: "2-1", score: 0.9 }, { id: "4-1", score: 0.89 }, { id: "1-1", score: 0.88 }, { id: "3-1", score: 0.7 }].filter((h) => ids.includes(h.id)),
    }));
    const meaning = await voteMeaning(db, a, {}, "pensions", semantic);
    expect(semantic).toHaveBeenCalledWith("rollCalls", "pensions", ["4-1", "3-1", "2-1", "1-1"]);
    const r = await hybridVotes(db, a, { terms: ["aposentadoria"], phrase: "aposentadoria", filters: {}, meaning, ...page });
    expect(r.meaning).toBe("used");
    expect(r.total).toBe(3); // 3-1 is too far from the best hit
    expect(r.rows.map((v) => [v.rollCallId, v.byMeaning])).toEqual([["1-1", false], ["2-1", true], ["4-1", true]]);
    // the rows only meaning found are counted apart (never part of "N of M recorded votes")
    expect(r.meaningOnly).toBe(2);

    // the other filters narrow the ranked votes too
    const april = await voteMeaning(db, a, { from: "2026-04" }, "pensions", semantic);
    expect(semantic).toHaveBeenLastCalledWith("rollCalls", "pensions", ["4-1"]);
    const r2 = await hybridVotes(db, a, { terms: ["aposentadoria"], filters: { from: "2026-04" }, meaning: april, ...page });
    expect(r2.rows.map((v) => v.rollCallId)).toEqual(["4-1"]);
    // a meaning hit that doesn't pass the filters never shows
    const r3 = await hybridVotes(db, a, { terms: ["aposentadoria"], filters: { vote: "Sim" }, meaning, ...page });
    expect(r3.rows.map((v) => v.rollCallId)).toEqual(["1-1", "4-1"]);
  });

  it("votes: a worker that didn't answer leaves the word matches, best first, and says so", async () => {
    const a = await setup();
    const r = await hybridVotes(db, a, { terms: ["aposentadoria", "previdência"], filters: {}, meaning: { ok: false, hits: [] }, ...page });
    expect(r.meaning).toBe("unavailable");
    expect(r.rows.every((v) => !v.byMeaning)).toBe(true);
    expect(r.rows.map((v) => v.rollCallId).sort()).toEqual(["1-1", "2-1"]);
    expect(r.meaningOnly).toBe(0);
  });

  it("votes: exact words (no meaning) keep the word rank, best first, and say so", async () => {
    const a = await setup();
    await upsertRollCalls(db, [{
      id: "1-1", date: "2026-03-01", registeredAt: null, description: "Aprovado o projeto da aposentadoria.", yes: 1, no: 1, other: 0, billId: null,
      billLabel: "PL 1/2026", billSummary: "Dispõe sobre a aposentadoria rural e a aposentadoria especial",
    }]);
    await upsertRollCalls(db, [{
      id: "4-1", date: "2026-04-01", registeredAt: null, description: "Aprovado.", yes: 1, no: 1, other: 0, billId: null, billLabel: "PL 1/2026",
      billSummary: "Benefício para pescadores e aposentadoria",
    }]);
    const r = await hybridVotes(db, a, { terms: ["aposentadoria"], phrase: "aposentadoria", filters: {}, meaning: null, ...page });
    expect(r).toMatchObject({ meaning: "words", meaningOnly: 0, total: 2 });
    expect(r.rows.map((v) => v.rollCallId)).toEqual(["1-1", "4-1"]); // best match first, not newest
  });

  it("bills: fused the same way; the type filter and the counts by type follow the fused list", async () => {
    const a = await setup();
    const semantic = vi.fn<RecordSemantic>(async () => ({ ok: true, hits: [{ id: "11", score: 0.88 }, { id: "12", score: 0.6 }] }));
    const meaning = await billMeaning(db, a, {}, "pensions", semantic);
    expect(semantic).toHaveBeenCalledWith("bills", "pensions", ["12", "11", "10"]);
    const r = await hybridBills(db, a, { terms: ["aposentadoria"], meaning, ...page });
    expect(r).toMatchObject({ meaning: "used", total: 2, all: 3, byType: [{ type: "PL", n: 1 }, { type: "REQ", n: 1 }] });
    expect(r.rows.map((b) => [b.id, b.byMeaning])).toEqual([[10, false], [11, true]]);
    expect(r.meaningOnly).toBe(1);
    const req = await hybridBills(db, a, { terms: ["aposentadoria"], type: "REQ", meaning, ...page });
    expect(req).toMatchObject({ total: 1, meaningOnly: 1 });
    expect(req.rows.map((b) => b.id)).toEqual([11]);
    expect(await hybridBills(db, a, { terms: ["aposentadoria"], type: "PL", meaning, ...page })).toMatchObject({ total: 1, meaningOnly: 0 });
    const down = await hybridBills(db, a, { terms: ["aposentadoria"], meaning: { ok: false, hits: [] }, ...page });
    expect(down).toMatchObject({ meaning: "unavailable", total: 1 });
  });
});
