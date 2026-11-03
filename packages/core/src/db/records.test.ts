import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { RecordRef } from "../recordRef.ts";
import { createDb, type Db } from "./client.ts";
import { createCustomPerson, listAttributions, replaceAiAttributions } from "./names.ts";
import { createSession, type Session } from "./repo.ts";
import { claimRecordFetch, failRecordFetch, finishRecordFetch, getSessionRecord, linkRecord } from "./records.ts";

let db: Db;
let close: () => Promise<void>;
let s: Session;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions RESTART IDENTITY CASCADE");
  await pool.end();
  s = await createSession(db, { title: "T", source: "upload" });
});

const senado = (date = "2026-09-02"): RecordRef => ({ chamber: "senado", date, sessionCode: null, url: `https://x/${date}` });

describe("session records", () => {
  it("linkRecord upserts one row per session, pending, and a re-link clears the old result", async () => {
    expect(await getSessionRecord(db, s.id)).toBeNull();
    await linkRecord(db, s.id, senado());
    expect(await getSessionRecord(db, s.id)).toMatchObject({ chamber: "senado", status: "pending", error: null, rawKey: null, ref: senado() });
    await claimRecordFetch(db, s.id);
    await finishRecordFetch(db, s.id, { rawKey: `${s.id}/names/record.json` });
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "matched", rawKey: `${s.id}/names/record.json` });
    await linkRecord(db, s.id, { chamber: "camara", eventId: "9", url: "https://c/9" });
    expect(await getSessionRecord(db, s.id)).toMatchObject({ chamber: "camara", status: "pending", rawKey: null, fetchedAt: null });
  });

  it("claimRecordFetch claims once", async () => {
    await linkRecord(db, s.id, senado());
    const [a, b] = await Promise.all([claimRecordFetch(db, s.id), claimRecordFetch(db, s.id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await getSessionRecord(db, s.id))?.status).toBe("running");
    expect(await claimRecordFetch(db, s.id)).toBeNull();
    expect(await claimRecordFetch(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("finish and fail only act on a running row; failing keeps the friendly text, a re-link makes it claimable again", async () => {
    await linkRecord(db, s.id, senado());
    await failRecordFetch(db, s.id, "nope"); // pending: untouched
    expect((await getSessionRecord(db, s.id))?.status).toBe("pending");
    expect(await finishRecordFetch(db, s.id, { rawKey: "k" })).toBe(false);
    await claimRecordFetch(db, s.id);
    await failRecordFetch(db, s.id, "The Senado has no speeches for that date.");
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "failed", error: "The Senado has no speeches for that date." });
    await linkRecord(db, s.id, senado("2026-09-03"));
    expect(await claimRecordFetch(db, s.id)).toMatchObject({ status: "running", error: null });
  });
});

describe("linkRecord and the record's names", () => {
  const rowFor = (personId: string | null, status: "confirmed" | "rejected" = "confirmed") => ({
    speakerId: "A", startMs: 0, endMs: 1000, personId, status, confidence: 0.9, evidence: { kind: "record" as const, speechId: "1", score: 0.9, url: "u", fetchedAt: "t" },
  });
  const current = async () => (await listAttributions(db, s.id)).filter((a) => a.source === "record");

  it("linking a different record supersedes the old record's rows (rejections stay); the same record keeps them", async () => {
    const p = await createCustomPerson(db, { displayName: "P", createdBy: "t" });
    await linkRecord(db, s.id, senado("2026-09-02"));
    await replaceAiAttributions(db, s.id, "record", [rowFor(p.id), { ...rowFor(p.id, "rejected"), speakerId: "B" }]);
    await linkRecord(db, s.id, senado("2026-09-02")); // same record (a retry)
    expect(await current()).toHaveLength(2);
    await linkRecord(db, s.id, senado("2026-09-03")); // another one
    expect((await current()).map((r) => r.status)).toEqual(["rejected"]);
  });
});
