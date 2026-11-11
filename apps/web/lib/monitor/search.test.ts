import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, replaceSpeechWindow, upsertMembers, type Db } from "@digestor/core/server";
import { runSearch, type TranslateResult } from "./search";

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
    const r = await runSearch(db, "x".repeat(300), translate);
    expect(translate).toHaveBeenCalledWith("x".repeat(200));
    expect(r.q).toHaveLength(200);
  });

  it("an empty query returns empty groups without touching the database", async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as Db;
    const r = await runSearch(noDb, "   ");
    expect(r).toMatchObject({ q: "", terms: [], members: [], speeches: { total: 0, rows: [] }, rollCalls: [] });
  });

  it("finds a deputy by name and speeches by the translated terms", async () => {
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS", photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(204407)!, "2026-02-01", "2026-11-11", [
      { startsAt: "2026-03-17T18:00", phase: null, kind: null, summary: "", text: "O feminicídio no RS", keywords: "" },
    ]);
    const r = await runSearch(db, "femicide", async () => ({ terms: ["feminicídio", "violência contra a mulher"], translated: true, failed: false }));
    expect(r.terms).toEqual(["feminicídio", "violência contra a mulher"]);
    expect(r.translatedFrom).toBe("femicide");
    expect(r.speeches.total).toBe(1);
    expect((await runSearch(db, "melchionna")).members.map((m) => m.externalId)).toEqual([204407]);
  });

  it("without a translator, or when it fails, searches the words as typed", async () => {
    expect((await runSearch(db, "feminicídio")).terms).toEqual(["feminicídio"]);
    const failed = await runSearch(db, "femicide", async (q) => ({ terms: [q], translated: false, failed: true }));
    expect(failed).toMatchObject({ terms: ["femicide"], translatedFrom: null, notice: "translationFailed" });
  });
});
