import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { replaceSpeechWindow, upsertMembers, type SpeechInput } from "./monitor.ts";
import { upsertSessions } from "./monitorRecord.ts";
import {
  claimSessionVideo, finishSessionVideo, queueSessionVideos, replaceSessionSpeechVideos, speechesInRange, speechVideos,
} from "./monitorVideo.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(
    "TRUNCATE parl_speech_videos, parl_session_videos, parl_presence, parl_sessions, parl_speeches, parl_members RESTART IDENTITY CASCADE",
  );
  await pool.end();
});

const speech = (startsAt: string, text: string): SpeechInput => ({ startsAt, phase: "Breves Comunicações", kind: "Discurso", summary: "", text, keywords: "" });
const session = (id: number, startsAt: string, status = "Encerrada") => ({ id, startsAt, description: "Sessão Deliberativa", status });

describe("monitor videos", () => {
  it("queues held sessions once, claims the newest pending first, and finishes only a running row", async () => {
    await upsertSessions(db, [session(1, "2026-06-30T14:24"), session(2, "2026-07-01T14:00"), session(3, "2026-07-02T14:00", "Cancelada")]);
    expect(await queueSessionVideos(db)).toEqual({ added: 2, requeued: 0 });
    expect(await queueSessionVideos(db)).toEqual({ added: 0, requeued: 0 });

    const a = await claimSessionVideo(db);
    expect(a).toEqual({ sessionId: 2, attempts: 1, startsAt: "2026-07-01 14:00:00" });
    const b = await claimSessionVideo(db);
    expect(b?.sessionId).toBe(1);
    expect(await claimSessionVideo(db)).toBeNull(); // both running

    expect(await finishSessionVideo(db, 2, { status: "no_video", retryAt: new Date("2026-07-02T00:00:00Z") })).toBe(true);
    expect(await finishSessionVideo(db, 2, { status: "done" })).toBe(false); // no longer running
    // due retry: claimable again
    expect((await claimSessionVideo(db, new Date("2026-07-02T00:00:01Z")))?.sessionId).toBe(2);
  });

  it("takes over a running row untouched for 30 minutes", async () => {
    await upsertSessions(db, [session(1, "2026-06-30T14:24")]);
    await queueSessionVideos(db);
    await claimSessionVideo(db);
    expect(await claimSessionVideo(db, new Date(Date.now() + 10 * 60_000))).toBeNull();
    expect(await claimSessionVideo(db, new Date(Date.now() + 31 * 60_000))).toMatchObject({ sessionId: 1, attempts: 2 });
  });

  it("sends a done session back to pending when new speech texts arrived", async () => {
    await upsertSessions(db, [session(1, "2026-06-30T14:24")]);
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "A", party: "PL", uf: "RS", photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(1)!, "2026-06-30", "2026-06-30", [speech("2026-06-30T14:28", "um"), speech("2026-06-30T15:00", "")]);
    await queueSessionVideos(db);
    await claimSessionVideo(db);
    await finishSessionVideo(db, 1, { status: "done", videoId: "v", streamStart: "2026-06-30 14:24:31", durationS: 3600, spoken: 1, matched: 1 });
    expect((await queueSessionVideos(db)).requeued).toBe(0);
    await replaceSpeechWindow(db, ids.get(1)!, "2026-06-30", "2026-06-30", [speech("2026-06-30T14:28", "um"), speech("2026-06-30T15:00", "dois")]);
    expect((await queueSessionVideos(db)).requeued).toBe(1);
    expect(await claimSessionVideo(db)).toMatchObject({ sessionId: 1 });
  });

  it("sends a done session back to pending when a speech it placed got a new key (its text changed)", async () => {
    await upsertSessions(db, [session(1, "2026-06-30T14:24")]);
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "A", party: "PL", uf: "RS", photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(1)!, "2026-06-30", "2026-06-30", [speech("2026-06-30T14:28", "um")]);
    await queueSessionVideos(db);
    await claimSessionVideo(db);
    const [placed] = await speechesInRange(db, "2026-06-30 14:00:00", "2026-06-30 16:00:00");
    await replaceSessionSpeechVideos(db, 1, "v", [{ speechKey: placed!.speechKey, startS: 10, endS: 60, score: 0.9 }]);
    await finishSessionVideo(db, 1, { status: "done", videoId: "v", streamStart: "2026-06-30 14:24:31", durationS: 3600, spoken: 1, matched: 1 });
    expect((await queueSessionVideos(db)).requeued).toBe(0);

    // the nightly refresh stores a revised text: same speech count, new key, the video row now points nowhere
    await replaceSpeechWindow(db, ids.get(1)!, "2026-06-30", "2026-06-30", [speech("2026-06-30T14:28", "um revisto")]);
    expect((await queueSessionVideos(db)).requeued).toBe(1);
    expect(await claimSessionVideo(db)).toMatchObject({ sessionId: 1 });
  });

  it("stores speech moments per session; an overlapping session keeps the better score", async () => {
    await upsertSessions(db, [session(1, "2026-06-30T10:00"), session(2, "2026-06-30T14:00")]);
    const ids = await upsertMembers(db, [{ house: "camara", externalId: 1, name: "A", party: "PL", uf: "RS", photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(1)!, "2026-06-30", "2026-06-30", [speech("2026-06-30T13:58", "um"), speech("2026-06-30T14:30", "dois")]);
    const rows = await speechesInRange(db, "2026-06-30 13:00:00", "2026-06-30 15:00:00");
    expect(rows.map((r) => r.text)).toEqual(["um", "dois"]);
    const [k1, k2] = rows.map((r) => r.speechKey);

    await replaceSessionSpeechVideos(db, 1, "morning", [{ speechKey: k1!, startS: 100, endS: 200, score: 0.7 }]);
    await replaceSessionSpeechVideos(db, 2, "afternoon", [{ speechKey: k1!, startS: 5, endS: 60, score: 0.9 }, { speechKey: k2!, startS: 300, endS: 400, score: 0.8 }]);
    await replaceSessionSpeechVideos(db, 1, "morning", [{ speechKey: k1!, startS: 100, endS: 200, score: 0.7 }]); // rerun: worse score loses
    const v = await speechVideos(db, [k1!, k2!, "missing"]);
    expect(v.get(k1!)).toEqual({ videoId: "afternoon", startS: 5, endS: 60 });
    expect(v.get(k2!)).toEqual({ videoId: "afternoon", startS: 300, endS: 400 });
    expect(v.has("missing")).toBe(false);

    await replaceSessionSpeechVideos(db, 2, "afternoon", []); // a rerun that matched nothing clears that session's rows
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from parl_speech_videos`);
    expect(left.rows[0]!.n).toBe(0);
  });
});
