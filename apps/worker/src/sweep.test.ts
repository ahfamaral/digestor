import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { QUEUES } from "@digestor/core";
import {
  createDb, createSession, getAnalysisVersion, getSession, startAnalysisVersion, updateSession, type Db, type Stage,
} from "@digestor/core/server";
import { sweepStaleSessions } from "./sweep.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const MIN = 60_000;

d("sweepStaleSessions", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    // The test database has no pgboss schema until pg-boss has started against it.
    const boss = new PgBoss(url!);
    boss.on("error", () => {});
    await boss.start();
    for (const q of [QUEUES.start, QUEUES.resume, QUEUES.reanalyze]) await boss.createQueue(q);
    await boss.stop({ graceful: false });
  });
  afterAll(async () => {
    await db.execute(sql`delete from pgboss.job where data->>'testSweep' = 'yes'`);
    await close();
  });

  async function seed(stage: Stage, ageMin: number) {
    const s = await createSession(db, { source: "upload", title: "sweep" });
    await updateSession(db, s.id, { stage });
    // updateSession always stamps updated_at = now(), so age the row directly.
    await db.execute(sql`update sessions set updated_at = ${new Date(Date.now() - ageMin * MIN).toISOString()}::timestamptz where id = ${s.id}`);
    return s.id;
  }
  async function job(queue: string, sessionId: string, state: string) {
    const data = JSON.stringify({ sessionId, testSweep: "yes" });
    await db.execute(sql`insert into pgboss.job (name, data, state) values (${queue}, ${data}::jsonb, ${state}::pgboss.job_state)`);
  }
  const META = { profile: "general", reason: "initial", models: {}, promptVersions: {} };
  async function runningVersion(sessionId: string, ageMin: number) {
    const v = await startAnalysisVersion(db, sessionId, META);
    await db.execute(sql`update analysis_versions set created_at = ${new Date(Date.now() - ageMin * MIN).toISOString()}::timestamptz where id = ${v.id}`);
    return v.id;
  }

  it("fails a stale session with no job but spares one with an active job", async () => {
    const dead = await seed("transcribing", 200);
    const alive = await seed("transcribing", 200);
    await job(QUEUES.start, alive, "active");
    const ids = await sweepStaleSessions(db);
    expect(ids).toContain(dead);
    expect(ids).not.toContain(alive);
    const s = await getSession(db, dead);
    expect(s).toMatchObject({ stage: "failed", error: "Processing stopped unexpectedly. Please start over." });
    expect((await getSession(db, alive))?.stage).toBe("transcribing");
  });

  it("spares a recent in-progress session and ignores awaiting_context", async () => {
    const recent = await seed("preparing", 10);
    const waiting = await seed("awaiting_context", 500);
    const ids = await sweepStaleSessions(db);
    expect(ids).not.toContain(recent);
    expect(ids).not.toContain(waiting);
    expect((await getSession(db, waiting))?.stage).toBe("awaiting_context");
  });

  it("sweep fails a stale running re-analysis version but not one with a live job", async () => {
    const dead = await seed("ready", 500);
    const alive = await seed("ready", 500);
    const deadV = await runningVersion(dead, 200);
    const aliveV = await runningVersion(alive, 200);
    await job(QUEUES.reanalyze, alive, "retry");
    const freshSession = await seed("ready", 500);
    const freshV = await runningVersion(freshSession, 5);
    const ids = await sweepStaleSessions(db);
    expect(ids).not.toContain(dead); // the session itself is ready: untouched
    expect((await getSession(db, dead))?.stage).toBe("ready");
    expect((await getAnalysisVersion(db, deadV))?.status).toBe("failed");
    expect((await getAnalysisVersion(db, aliveV))?.status).toBe("running");
    expect((await getAnalysisVersion(db, freshV))?.status).toBe("running");
  });

  it("fails the running version of a session it fails", async () => {
    const id = await seed("finding_moments", 300);
    const v = await runningVersion(id, 1); // version is recent, but the session is dead
    expect(await sweepStaleSessions(db)).toContain(id);
    expect((await getAnalysisVersion(db, v))?.status).toBe("failed");
  });
});
