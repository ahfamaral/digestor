import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, replaceSpeechWindow, upsertMembers, type Db } from "@digestor/core/server";
import { parseLanding, type LandingParams } from "./params";
import { runSearch, type TranslateResult } from "./search";

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
