import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { QUEUES } from "@digestor/core";
import {
  claimClipRender, createClip, createDb, createSession, createTrack, getAnalysisVersion, getClip, getSession, getTrack,
  claimFindMore, claimProxy, claimRecordFetch, requestProxy, getSessionRecord, linkRecord, createCustomPerson, getFindMore, getTranslation, requestFindMore, requestTranslation, setTrackBurnStatus, startAnalysisVersion, updateSession, type Db, type Stage,
} from "@digestor/core/server";
import { STUCK_MESSAGE, sweepStaleJobRows, sweepStaleSessions } from "./sweep.js";

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
    for (const q of [QUEUES.start, QUEUES.resume, QUEUES.reanalyze, QUEUES.translateBriefing, QUEUES.prepareTrack, QUEUES.renderClip, QUEUES.burnTrack, QUEUES.findMore, QUEUES.names, QUEUES.proxy]) {
      await boss.createQueue(q);
    }
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
    await jobWith(queue, { sessionId }, state);
  }
  async function jobWith(queue: string, payload: Record<string, string>, state: string) {
    const data = JSON.stringify({ ...payload, testSweep: "yes" });
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

  it("a live proxy job keeps a preparing_preview session alive; without one it is failed", async () => {
    const dead = await seed("preparing_preview", 200);
    const alive = await seed("preparing_preview", 200);
    await job(QUEUES.proxy, alive, "active");
    const ids = await sweepStaleSessions(db);
    expect(ids).toContain(dead);
    expect(ids).not.toContain(alive);
    expect((await getSession(db, alive))?.stage).toBe("preparing_preview");
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

d("sweepStaleJobRows (R32)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(() => {
    ({ db, close } = createDb(url!));
  });
  afterAll(async () => {
    await db.execute(sql`delete from pgboss.job where data->>'testSweep' = 'yes'`);
    await close();
  });

  const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
  async function jobWith(queue: string, payload: Record<string, string>, state: string) {
    const data = JSON.stringify({ ...payload, testSweep: "yes" });
    await db.execute(sql`insert into pgboss.job (name, data, state) values (${queue}, ${data}::jsonb, ${state}::pgboss.job_state)`);
  }
  async function clipIn() {
    const s = await createSession(db, { source: "upload", title: "rows" });
    return createClip(db, { sessionId: s.id, ownerId: "owner", startMs: 0, endMs: 30_000, actor: "user" });
  }

  it("fails stuck translations, tracks, renders and burns older than 30 min with no live job", async () => {
    const s = await createSession(db, { source: "upload", title: "rows" });
    const v = await startAnalysisVersion(db, s.id, { profile: "general", reason: "initial", models: {}, promptVersions: {} });
    await requestTranslation(db, v.id, "pt", "briefing");
    await requestTranslation(db, v.id, "de", "briefing");
    await requestTranslation(db, v.id, "fr", "briefing");
    await db.execute(sql`update translations set updated_at = ${ago(45)}::timestamptz where analysis_id = ${v.id} and language in ('pt', 'de')`);
    await jobWith(QUEUES.translateBriefing, { analysisId: v.id, language: "de" }, "retry"); // de is alive, fr is recent

    const clip = await clipIn();
    const stuckTrack = (await createTrack(db, clip.id, "pt"))!;
    const liveTrack = (await createTrack(db, clip.id, "de"))!;
    const freshTrack = (await createTrack(db, clip.id, "fr"))!;
    await db.execute(sql`update subtitle_tracks set updated_at = ${ago(45)}::timestamptz where id in (${stuckTrack.id}, ${liveTrack.id})`);
    await jobWith(QUEUES.prepareTrack, { trackId: liveTrack.id }, "active");

    const stuckClip = await clipIn();
    const liveClip = await clipIn();
    for (const c of [stuckClip, liveClip]) await claimClipRender(db, c.id);
    await db.execute(sql`update clips set render_status = 'rendering' where id = ${stuckClip.id}`);
    await db.execute(sql`update clips set updated_at = ${ago(45)}::timestamptz where id in (${stuckClip.id}, ${liveClip.id})`);
    await jobWith(QUEUES.renderClip, { clipId: liveClip.id }, "created");

    const burnClip = await clipIn();
    const stuckBurn = (await createTrack(db, burnClip.id, "pt"))!;
    const doneJobBurn = (await createTrack(db, burnClip.id, "de"))!;
    await setTrackBurnStatus(db, stuckBurn.id, "queued");
    await setTrackBurnStatus(db, doneJobBurn.id, "rendering");
    await db.execute(sql`update subtitle_tracks set status = 'ready', updated_at = ${ago(45)}::timestamptz where clip_id = ${burnClip.id}`);
    await jobWith(QUEUES.burnTrack, { trackId: doneJobBurn.id }, "completed"); // a finished job is not live

    const counts = await sweepStaleJobRows(db);
    expect(counts).toMatchObject({ translations: 1, tracks: 1, renders: 1, burns: 2 });

    expect(await getTranslation(db, v.id, "pt", "briefing")).toMatchObject({ status: "failed", error: STUCK_MESSAGE });
    expect((await getTranslation(db, v.id, "de", "briefing"))?.status).toBe("pending");
    expect((await getTranslation(db, v.id, "fr", "briefing"))?.status).toBe("pending");
    expect(await getTrack(db, stuckTrack.id)).toMatchObject({ status: "failed", error: STUCK_MESSAGE });
    expect((await getTrack(db, liveTrack.id))?.status).toBe("preparing");
    expect((await getTrack(db, freshTrack.id))?.status).toBe("preparing");
    expect((await getClip(db, stuckClip.id))?.renderStatus).toBe("failed");
    expect((await getClip(db, liveClip.id))?.renderStatus).toBe("queued");
    expect((await getTrack(db, stuckBurn.id))?.burnStatus).toBe("failed");
    expect((await getTrack(db, doneJobBurn.id))?.burnStatus).toBe("failed");
    expect((await getTrack(db, stuckBurn.id))?.status).toBe("ready"); // the subtitles themselves are untouched

    // the existing retry paths work again: a failed render can be claimed, a failed translation re-requested
    expect(await claimClipRender(db, stuckClip.id)).toBe(true);
    await requestTranslation(db, v.id, "pt", "briefing");
    expect(await getTranslation(db, v.id, "pt", "briefing")).toMatchObject({ status: "pending", error: null });
  });

  it("sweep fails a stuck find-more request (pending or running, 30 min, no live job)", async () => {
    const s = await createSession(db, { source: "upload", title: "rows" });
    const v = await startAnalysisVersion(db, s.id, { profile: "general", reason: "initial", models: {}, promptVersions: {} });
    const [a, b, c, fresh] = await Promise.all(["A", "B", "C", "D"].map((n) => createCustomPerson(db, { displayName: n, createdBy: "t" })));
    const rows = [];
    for (const p of [a!, b!, c!, fresh!]) rows.push((await requestFindMore(db, { ownerId: "owner", analysisId: v.id, personId: p.id }))!);
    await claimFindMore(db, rows[1]!.id); // b is running
    await db.execute(sql`update find_more_requests set updated_at = ${ago(45)}::timestamptz where id in (${rows[0]!.id}, ${rows[1]!.id}, ${rows[2]!.id})`);
    await jobWith(QUEUES.findMore, { requestId: rows[2]!.id }, "active"); // c is alive, d is recent

    expect(await sweepStaleJobRows(db)).toMatchObject({ findMore: 2 });
    const get = (i: number) => getFindMore(db, { ownerId: "owner", analysisId: v.id, personId: [a!, b!, c!, fresh!][i]!.id });
    expect(await get(0)).toMatchObject({ status: "failed", error: STUCK_MESSAGE });
    expect(await get(1)).toMatchObject({ status: "failed", error: STUCK_MESSAGE });
    expect((await get(2))?.status).toBe("pending");
    expect((await get(3))?.status).toBe("pending");
    // asking again works after the sweep
    expect((await requestFindMore(db, { ownerId: "owner", analysisId: v.id, personId: a!.id }))?.status).toBe("pending");
  });

  it("sweep fails a stuck record fetch (pending or running, 30 min, no live names/start job); a re-link counts as fresh", async () => {
    const ref = { chamber: "senado" as const, date: "2026-09-02", sessionCode: null, url: "https://x" };
    const ids: string[] = [];
    for (const n of ["a", "b", "c", "d", "e"]) {
      const s = await createSession(db, { source: "upload", title: `rec ${n}` });
      await linkRecord(db, s.id, ref);
      ids.push(s.id);
    }
    await claimRecordFetch(db, ids[1]!); // b is running
    await db.execute(sql`update session_records set updated_at = ${ago(45)}::timestamptz where session_id in (${ids[0]!}, ${ids[1]!}, ${ids[2]!}, ${ids[3]!})`);
    await jobWith(QUEUES.names, { sessionId: ids[2]! }, "active"); // c has a live names job
    await jobWith(QUEUES.start, { sessionId: ids[3]! }, "created"); // d's graph has yet to run its record step; e is recent
    expect(await sweepStaleJobRows(db)).toMatchObject({ records: 2 });
    const status = async (i: number) => (await getSessionRecord(db, ids[i]!))?.status;
    expect([await status(0), await status(1), await status(2), await status(3), await status(4)]).toEqual(["failed", "failed", "pending", "pending", "pending"]);
    expect(await getSessionRecord(db, ids[0]!)).toMatchObject({ error: STUCK_MESSAGE });
    await linkRecord(db, ids[0]!, ref); // linking again after the failure: fresh, so the next sweep leaves it
    await sweepStaleJobRows(db);
    expect(await status(0)).toBe("pending");
  });

  it("a waiting or suggested record is not job-owned: the sweep leaves it alone however old", async () => {
    const ref = { chamber: "senado" as const, date: "2026-09-02", sessionCode: null, url: "https://x" };
    const ids: string[] = [];
    for (const status of ["waiting", "suggested"]) {
      const s = await createSession(db, { source: "upload", title: status });
      await linkRecord(db, s.id, ref);
      await db.execute(sql`update session_records set status = ${status}, updated_at = ${ago(600)}::timestamptz where session_id = ${s.id}`);
      ids.push(s.id);
    }
    expect(await sweepStaleJobRows(db)).toMatchObject({ records: 0 });
    expect([(await getSessionRecord(db, ids[0]!))?.status, (await getSessionRecord(db, ids[1]!))?.status]).toEqual(["waiting", "suggested"]);
  });

  it("an accepted suggestion waiting at the context check stays pending; the same row on a ready session with no job fails", async () => {
    const ref = { chamber: "senado" as const, date: "2026-09-02", sessionCode: null, url: "https://x" };
    const mk = async (stage: "awaiting_context" | "ready") => {
      const s = await createSession(db, { source: "upload", title: stage });
      await updateSession(db, s.id, { stage });
      await linkRecord(db, s.id, ref);
      await db.execute(sql`update session_records set updated_at = ${ago(45)}::timestamptz where session_id = ${s.id}`);
      return s.id;
    };
    const waiting = await mk("awaiting_context");
    const ready = await mk("ready");
    expect(await sweepStaleJobRows(db)).toMatchObject({ records: 1 });
    expect((await getSessionRecord(db, waiting))?.status).toBe("pending");
    expect(await getSessionRecord(db, ready)).toMatchObject({ status: "failed", error: STUCK_MESSAGE });
  });

  it("a stuck proxy row with no live job is failed and the session settled", async () => {
    const mk = async (patch: { stage: Stage; status: "pending" | "running"; ageMin: number }) => {
      const s = await createSession(db, { source: "upload", title: "proxy" });
      await requestProxy(db, s.id);
      if (patch.status === "running") await claimProxy(db, s.id);
      await updateSession(db, s.id, { stage: patch.stage });
      await db.execute(sql`update sessions set updated_at = ${ago(patch.ageMin)}::timestamptz where id = ${s.id}`);
      return s.id;
    };
    const waiting = await mk({ stage: "preparing_preview", status: "running", ageMin: 45 });
    const early = await mk({ stage: "awaiting_context", status: "pending", ageMin: 45 });
    const live = await mk({ stage: "preparing_preview", status: "running", ageMin: 45 });
    const fresh = await mk({ stage: "preparing_preview", status: "running", ageMin: 5 });
    await jobWith(QUEUES.proxy, { sessionId: live }, "active");
    const earlyClock = (await getSession(db, early))!.updatedAt.getTime();
    expect(await sweepStaleJobRows(db)).toMatchObject({ proxies: 2 });
    expect(await getSession(db, waiting)).toMatchObject({ proxyStatus: "failed", stage: "failed", error: "The video preview couldn't be prepared. Please try again." });
    expect(await getSession(db, early)).toMatchObject({ proxyStatus: "failed", stage: "awaiting_context" }); // the analysis step fails it before paying
    // Failing the copy doesn't restart the session's own 120-minute clock.
    expect((await getSession(db, early))!.updatedAt.getTime()).toBe(earlyClock);
    expect(await getSession(db, live)).toMatchObject({ proxyStatus: "running", stage: "preparing_preview" });
    expect(await getSession(db, fresh)).toMatchObject({ proxyStatus: "running", stage: "preparing_preview" });
  });

  it("a stuck proxy row with a done copy is left alone", async () => {
    const s = await createSession(db, { source: "upload", title: "proxy done" });
    await updateSession(db, s.id, { proxyStatus: "done", proxyKey: "k", stage: "ready" });
    await db.execute(sql`update sessions set updated_at = ${ago(500)}::timestamptz where id = ${s.id}`);
    await sweepStaleJobRows(db);
    expect(await getSession(db, s.id)).toMatchObject({ proxyStatus: "done", stage: "ready" });
  });

  it("a re-requested translation counts as fresh (its job is about to be sent)", async () => {
    const s = await createSession(db, { source: "upload", title: "rows" });
    const v = await startAnalysisVersion(db, s.id, { profile: "general", reason: "initial", models: {}, promptVersions: {} });
    await requestTranslation(db, v.id, "pt", "briefing");
    await db.execute(sql`update translations set status = 'failed', updated_at = ${ago(300)}::timestamptz where analysis_id = ${v.id}`);
    await requestTranslation(db, v.id, "pt", "briefing");
    await sweepStaleJobRows(db);
    expect((await getTranslation(db, v.id, "pt", "briefing"))?.status).toBe("pending");
  });
});
