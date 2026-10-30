import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "./client.ts";
import {
  createSession, deleteSession, getContextCard, getSession, getTranscript, listExpiredSessions, saveContextCard,
  saveTranscript, setStage, transitionStage, updateSession, type Session,
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
    expect(await listExpiredSessions(db, 7)).toHaveLength(0);
    await updateSession(db, s.id, { createdAt: new Date(Date.now() - 8 * 86_400_000) });
    expect((await listExpiredSessions(db, 7)).map((x) => x.id)).toEqual([s.id]);
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
