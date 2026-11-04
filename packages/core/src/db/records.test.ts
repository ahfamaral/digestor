import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import type { RecordRef } from "../recordRef.ts";
import { createDb, type Db } from "./client.ts";
import { createCustomPerson, listAttributions, replaceAiAttributions } from "./names.ts";
import { sessionRecords } from "./schema.ts";
import { createSession, type Session } from "./repo.ts";
import { claimDueRecordRetries, requeueRecordRetry, waitRecordFetch, claimRecordFetch, failRecordFetch, finishRecordFetch, getSessionRecord, linkRecord, releaseRecordFetch, suggestRecordRow, acceptSuggestedRecord, dismissSuggestedRecord } from "./records.ts";

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

describe("releaseRecordFetch", () => {
  it("returns a running row to pending (clearing nothing else), only for the same ref", async () => {
    await linkRecord(db, s.id, senado());
    expect(await releaseRecordFetch(db, s.id, senado())).toBe(false); // pending: nothing to release
    await claimRecordFetch(db, s.id);
    expect(await releaseRecordFetch(db, s.id, senado("2026-09-03"))).toBe(false); // re-linked meanwhile
    expect((await getSessionRecord(db, s.id))?.status).toBe("running");
    expect(await releaseRecordFetch(db, s.id, senado())).toBe(true);
    expect((await getSessionRecord(db, s.id))?.status).toBe("pending");
    expect(await claimRecordFetch(db, s.id)).toMatchObject({ status: "running" });
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

  it("a waiting row with retryAt round-trips; claimRecordFetch claims only pending", async () => {
    await linkRecord(db, s.id, senado());
    const retryAt = new Date("2026-11-05T10:00:00Z");
    await db.update(sessionRecords).set({ status: "waiting", retryAt }).where(eq(sessionRecords.sessionId, s.id));
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "waiting", retryAt });
    expect(await claimRecordFetch(db, s.id)).toBeNull();
    await db.update(sessionRecords).set({ status: "suggested" }).where(eq(sessionRecords.sessionId, s.id));
    expect(await claimRecordFetch(db, s.id)).toBeNull();
  });

  it("linkRecord resets retryAt; linkedAt changes only when the ref changes", async () => {
    await linkRecord(db, s.id, senado("2026-09-02"));
    const first = (await getSessionRecord(db, s.id))!;
    expect(first.linkedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 20));
    await db.update(sessionRecords).set({ status: "waiting", retryAt: new Date() }).where(eq(sessionRecords.sessionId, s.id));
    await linkRecord(db, s.id, senado("2026-09-02"));
    const same = (await getSessionRecord(db, s.id))!;
    expect(same).toMatchObject({ status: "pending", retryAt: null });
    expect(same.linkedAt).toEqual(first.linkedAt);
    await linkRecord(db, s.id, senado("2026-09-03"));
    expect((await getSessionRecord(db, s.id))!.linkedAt.getTime()).toBeGreaterThan(first.linkedAt.getTime());
  });

  it("waitRecordFetch: running → waiting for the same ref only; claimDueRecordRetries: due rows → pending, once", async () => {
    await linkRecord(db, s.id, senado());
    await claimRecordFetch(db, s.id);
    expect(await waitRecordFetch(db, s.id, senado("2026-09-09"), new Date())).toBe(false); // another ref
    const retryAt = new Date("2026-11-05T10:00:00Z");
    expect(await waitRecordFetch(db, s.id, senado(), retryAt, "waiting line")).toBe(true);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "waiting", retryAt, error: "waiting line" });
    expect(await claimDueRecordRetries(db, new Date("2026-11-05T09:59:00Z"))).toEqual([]); // not due
    const both = await Promise.all([claimDueRecordRetries(db, retryAt), claimDueRecordRetries(db, retryAt)]);
    expect(both.flat()).toEqual([{ sessionId: s.id, ref: senado() }]); // exactly one caller got it
    expect((await getSessionRecord(db, s.id))!.status).toBe("pending");
  });

  it("a row re-linked while waiting is pending with the new ref and no retry time; the old ref's requeue does nothing", async () => {
    await linkRecord(db, s.id, senado());
    await claimRecordFetch(db, s.id);
    await waitRecordFetch(db, s.id, senado(), new Date("2026-11-05T10:00:00Z"));
    await linkRecord(db, s.id, senado("2026-09-03"));
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "pending", retryAt: null, ref: senado("2026-09-03") });
    expect(await requeueRecordRetry(db, s.id, senado(), new Date())).toBe(false);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "pending", ref: senado("2026-09-03") });
  });

  it("linked_at follows the database clock", async () => {
    await linkRecord(db, s.id, senado());
    await linkRecord(db, s.id, senado("2026-09-03"));
    const [row] = (await db.execute(sql`select (linked_at = (select now())) as same, abs(extract(epoch from (now() - linked_at))) < 5 as recent from session_records where session_id = ${s.id}`)).rows as { recent: boolean }[];
    expect(row!.recent).toBe(true);
  });
});

describe("suggestRecordRow", () => {
  it("inserts a suggested row when the session has none", async () => {
    expect(await suggestRecordRow(db, s.id, senado())).toBe(true);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ chamber: "senado", status: "suggested", ref: senado(), error: null });
  });

  it("never overwrites an existing row, whatever its status", async () => {
    await linkRecord(db, s.id, senado("2026-01-01"));
    expect(await suggestRecordRow(db, s.id, senado("2026-02-02"))).toBe(false);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "pending", ref: senado("2026-01-01") });
    await claimRecordFetch(db, s.id);
    await finishRecordFetch(db, s.id, { rawKey: "k" });
    expect(await suggestRecordRow(db, s.id, senado("2026-02-02"))).toBe(false);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "matched", ref: senado("2026-01-01") });
  });

  it("a second suggestion for the same session does nothing", async () => {
    expect(await suggestRecordRow(db, s.id, senado("2026-01-01"))).toBe(true);
    expect(await suggestRecordRow(db, s.id, senado("2026-02-02"))).toBe(false);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ ref: senado("2026-01-01") });
  });
});


describe("accepting or dismissing a suggestion", () => {
  it("accept with the stored ref turns the row pending", async () => {
    await suggestRecordRow(db, s.id, senado("2026-01-01"));
    expect(await acceptSuggestedRecord(db, s.id, senado("2026-01-01"))).toBe(true);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "pending", ref: senado("2026-01-01") });
    expect(await acceptSuggestedRecord(db, s.id, senado("2026-01-01"))).toBe(false); // no longer suggested
  });

  it("accept after a re-link to another ref changes nothing (the old ref is never resurrected)", async () => {
    await suggestRecordRow(db, s.id, senado("2026-01-01"));
    await linkRecord(db, s.id, senado("2026-03-03"));
    await db.update(sessionRecords).set({ status: "suggested" }).where(eq(sessionRecords.sessionId, s.id));
    expect(await acceptSuggestedRecord(db, s.id, senado("2026-01-01"))).toBe(false);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "suggested", ref: senado("2026-03-03") });
  });

  it("dismiss deletes only a suggested row with that ref", async () => {
    await suggestRecordRow(db, s.id, senado("2026-01-01"));
    expect(await dismissSuggestedRecord(db, s.id, senado("2026-02-02"))).toBe(false);
    expect(await getSessionRecord(db, s.id)).not.toBeNull();
    expect(await dismissSuggestedRecord(db, s.id, senado("2026-01-01"))).toBe(true);
    expect(await getSessionRecord(db, s.id)).toBeNull();
    await linkRecord(db, s.id, senado("2026-01-01"));
    expect(await dismissSuggestedRecord(db, s.id, senado("2026-01-01"))).toBe(false);
    expect(await getSessionRecord(db, s.id)).toMatchObject({ status: "pending" });
  });
});
