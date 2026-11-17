import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import { eq } from "drizzle-orm";
import { clips, sessionRecords, sessions } from "./schema.ts";
import { dayRef } from "../recordRef.ts";
import {
  createSession, deleteSession, getContextCard, getSession, getTranscript, listSessionsWithAudioToRelease, listSessionsWithExpiredVideo, saveContextCard,
  listSessionSummaries, saveTranscript, setStage, transitionStage, updateSession, type Session,
} from "./repo.ts";

let db: Db;
let close: () => Promise<void>;
let s: Session;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions, transcripts, context_cards RESTART IDENTITY CASCADE");
  await pool.end();
  s = await createSession(db, { title: "T", source: "upload", hint: "h" });
});

describe("sessions", () => {
  it("creates with defaults and updates stage", async () => {
    expect(s).toMatchObject({ stage: "uploaded", progress: 0, metadata: {}, originalKey: null, hint: "h" });
    await setStage(db, s.id, "failed", 10, "boom");
    expect(await getSession(db, s.id)).toMatchObject({ stage: "failed", progress: 10, error: "boom" });
    await setStage(db, s.id, "preparing", 20);
    expect((await getSession(db, s.id))!.error).toBeNull();
    expect((await updateSession(db, s.id, { audioKey: `${s.id}/audio.wav` })).audioKey).toBe(`${s.id}/audio.wav`);
  });

  it("creates with a caller-chosen id (upload saves the file before the row exists)", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const row = await createSession(db, { id, title: "U", source: "upload", originalKey: `${id}/original.mp4` });
    expect(row).toMatchObject({ id, originalKey: `${id}/original.mp4` });
  });

  it("lists expired sessions and cascades on delete", async () => {
    expect(await listSessionsWithExpiredVideo(db, 7)).toHaveLength(0);
    await updateSession(db, s.id, { createdAt: new Date(Date.now() - 8 * 86_400_000) });
    expect((await listSessionsWithExpiredVideo(db, 7)).map((x) => x.id)).toEqual([s.id]);
    await deleteSession(db, s.id);
    expect(await getSession(db, s.id)).toBeNull();
  });

  it("round-trips transcript and context card", async () => {
    const t = { language: "en", languageConfidence: 0.93, durationMs: 1000,
      words: [{ text: "hi", startMs: 0, endMs: 100, speaker: "A", confidence: 0.9 }] };
    await saveTranscript(db, s.id, t);
    await saveTranscript(db, s.id, t);
    expect(await getTranscript(db, s.id)).toEqual(t);
    expect(await getContextCard(db, s.id)).toBeNull();
    const card = { profile: "interview" } as never;
    await saveContextCard(db, s.id, card, 1);
    await saveContextCard(db, s.id, card, 2);
    expect(await getContextCard(db, s.id)).toEqual({ card, round: 2 });
  });
});

describe("transitionStage", () => {
  it("moves only when the session is in the expected stage", async () => {
    await setStage(db, s.id, "awaiting_context", 50);
    expect(await transitionStage(db, s.id, "awaiting_context", "understanding", 55)).toBe(true);
    expect(await getSession(db, s.id)).toMatchObject({ stage: "understanding", progress: 55 });
    expect(await transitionStage(db, s.id, "awaiting_context", "indexing", 70)).toBe(false);
    expect((await getSession(db, s.id))?.stage).toBe("understanding");
  });
});

describe("listSessionSummaries", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, n));
  it("orders by latest activity (session or clip) and counts only done live clips", async () => {
    const a = await createSession(db, { title: "A", source: "upload" });
    const b = await createSession(db, { title: "B", source: "upload" });
    await db.update(sessions).set({ updatedAt: at(2) }).where(eq(sessions.id, s.id));
    await db.update(sessions).set({ updatedAt: at(1) }).where(eq(sessions.id, a.id));
    await db.update(sessions).set({ updatedAt: at(3) }).where(eq(sessions.id, b.id));
    const base = { startMs: 0, endMs: 1000, format: "16:9" as const };
    await db.insert(clips).values([
      { ...base, sessionId: a.id, ownerId: "owner", renderStatus: "done", updatedAt: at(5) },
      { ...base, sessionId: a.id, ownerId: "owner", renderStatus: "none", updatedAt: at(4) },
      { ...base, sessionId: a.id, ownerId: "owner", renderStatus: "done", deletedAt: at(4), updatedAt: at(4) },
      { ...base, sessionId: a.id, ownerId: "other", renderStatus: "done", updatedAt: at(4) },
    ]);
    const list = await listSessionSummaries(db, "owner");
    expect(list.map((x) => x.title)).toEqual(["A", "B", "T"]);
    expect(list.map((x) => x.renderedClips)).toEqual([1, 0, 0]);
    expect(list[0]!.lastActivityAt).toEqual(at(5));
    expect(list[0]).toMatchObject({ id: a.id, stage: "uploaded", videoRemoved: false, profile: null });
  });

  it("carries createdAt, duration, progress, the linked chamber and the live clip count", async () => {
    const p = await createSession(db, { title: "P", source: "youtube" });
    await updateSession(db, p.id, { durationMs: 600_000 });
    await setStage(db, p.id, "transcribing", 40);
    await db.insert(sessionRecords).values({ sessionId: p.id, chamber: "camara", ref: dayRef("camara", "2026-06-30") });
    const base = { startMs: 0, endMs: 1000, format: "16:9" as const };
    await db.insert(clips).values([
      { ...base, sessionId: p.id, ownerId: "owner" },
      { ...base, sessionId: p.id, ownerId: "owner", renderStatus: "done" },
      { ...base, sessionId: p.id, ownerId: "owner", deletedAt: new Date() },
      { ...base, sessionId: p.id, ownerId: "other" },
    ]);
    const list = await listSessionSummaries(db, "owner");
    const row = list.find((x) => x.id === p.id)!;
    expect(row).toMatchObject({ chamber: "camara", clipCount: 2, renderedClips: 1, durationMs: 600_000, progress: 40 });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(list.find((x) => x.id === s.id)).toMatchObject({ chamber: null, clipCount: 0, renderedClips: 0, durationMs: null, progress: 0 });
  });

  it("counts only an accepted record as a linked body (suggested and failed are not linked)", async () => {
    const mk = async (title: string, status: "suggested" | "pending" | "running" | "waiting" | "matched" | "failed") => {
      const x = await createSession(db, { title, source: "youtube" });
      await db.insert(sessionRecords).values({ sessionId: x.id, chamber: "camara", ref: dayRef("camara", "2026-06-30"), status });
      return x.id;
    };
    const ids = {
      suggested: await mk("a", "suggested"), pending: await mk("b", "pending"), running: await mk("c", "running"),
      waiting: await mk("d", "waiting"), matched: await mk("e", "matched"), failed: await mk("f", "failed"),
    };
    const list = await listSessionSummaries(db, "owner");
    const chamber = (id: string) => list.find((x) => x.id === id)!.chamber;
    expect(chamber(ids.suggested)).toBeNull();
    expect(chamber(ids.failed)).toBeNull();
    for (const k of ["pending", "running", "waiting", "matched"] as const) expect(chamber(ids[k])).toBe("camara");
  });
});

describe("listSessionsWithAudioToRelease", () => {
  it("returns only ready sessions that still have an audio key", async () => {
    const make = async (stage: Session["stage"], audio: boolean) => {
      const row = await createSession(db, { title: stage, source: "upload" });
      return updateSession(db, row.id, { stage, audioKey: audio ? `${row.id}/audio.mp3` : null });
    };
    const ready = await make("ready", true);
    await make("ready", false);
    await make("failed", true);
    await make("preparing_preview", true);
    await make("transcribing", true);
    expect((await listSessionsWithAudioToRelease(db)).map((r) => r.id)).toEqual([ready.id]);
  });
});
