import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JOB_OPTIONS, OWNER_ID, QUEUES } from "@digestor/core";
import {
  approveTrack, createClip, createTrack, getClip, getTrack, requestTrackBurn, setMomentChecks, setTrackCues, updateClip,
  updateSession,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { POST as exportClips } from "./sessions/[id]/export/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => h.send.mockReset().mockResolvedValue("job-id"));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (sessionId: string, body: unknown) =>
  exportClips(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), ctx(sessionId));
const clean = {
  argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
};
const sends = (queue: string) => h.send.mock.calls.filter((c) => c[0] === queue);

/** A session with two clips; the first passes the checklist, the second has no checks, credit or acknowledgement. */
async function twoClips() {
  const { sessionId, moments } = await seedReadySession(h.db, [[10_000, 30_000], [40_000, 60_000]]);
  const mk = (i: number) =>
    createClip(h.db, { sessionId, ownerId: OWNER_ID, momentId: moments[i]!.id, startMs: 10_000 + i * 30_000, endMs: 30_000 + i * 30_000, actor: "user" });
  const good = await mk(0);
  const bad = await mk(1);
  await setMomentChecks(h.db, moments[0]!.id, clean);
  await updateClip(h.db, good.id, { noCreditNeeded: true }, "user");
  return { sessionId, moments, good, bad };
}

describe("POST /api/sessions/[id]/export", () => {
  it("export renders only clips whose checklist passes", async () => {
    const { sessionId, moments, good, bad } = await twoClips();
    const res = await post(sessionId, { clipIds: [good.id, bad.id] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(1);
    expect(body.blocked).toEqual([{ clipId: bad.id, failing: ["argument", "context", "flags", "credit"] }]);
    expect(sends(QUEUES.renderClip)).toEqual([[QUEUES.renderClip, { clipId: good.id }, { ...JOB_OPTIONS, singletonKey: good.id }]]);
    // the unchecked moment gets its check queued
    expect(sends(QUEUES.checkMoment)).toEqual([[QUEUES.checkMoment, { momentId: moments[1]!.id }, JOB_OPTIONS]]);
    expect((await getClip(h.db, good.id))?.renderStatus).toBe("queued");
    expect((await getClip(h.db, bad.id))?.renderStatus).toBe("none");
  });

  it("answers 400 listing the failing items when nothing can be exported", async () => {
    const { sessionId, bad } = await twoClips();
    const res = await post(sessionId, { clipIds: [bad.id] });
    expect(res.status).toBe(400);
    expect((await res.json()).blocked).toEqual([{ clipId: bad.id, failing: ["argument", "context", "flags", "credit"] }]);
    expect(sends(QUEUES.renderClip)).toHaveLength(0);
    // acknowledging the warnings and crediting the source lets it through
    await updateClip(h.db, bad.id, { warningsAck: true, credit: "Parliament TV" }, "user");
    expect((await post(sessionId, { clipIds: [bad.id] })).status).toBe(200);
  });

  it("export refuses when the video was removed", async () => {
    const { sessionId, good } = await twoClips();
    await updateSession(h.db, sessionId, { videoDeletedAt: new Date() });
    const res = await post(sessionId, { clipIds: [good.id] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The video was removed after 14 days. Re-upload it to make new clips." });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("concurrent export sends one job per clip", async () => {
    const { sessionId, good } = await twoClips();
    const [a, b] = await Promise.all([post(sessionId, { clipIds: [good.id] }), post(sessionId, { clipIds: [good.id] })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sends(QUEUES.renderClip)).toHaveLength(1);
    expect((await a.json()).queued + (await b.json()).queued).toBe(1);
  });

  it("burns an approved track that asked for it, and blocks an unapproved one", async () => {
    const { sessionId, good } = await twoClips();
    const track = (await createTrack(h.db, good.id, "pt"))!;
    await setTrackCues(h.db, track.id, [{ startMs: 0, endMs: 1000, original: "Hi", text: "Olá", missing: false }], "ready");
    await requestTrackBurn(h.db, track.id, true);
    const blocked = await post(sessionId, { clipIds: [good.id] });
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).blocked).toEqual([{ clipId: good.id, failing: ["subtitles"] }]);
    await approveTrack(h.db, track.id);
    const res = await post(sessionId, { clipIds: [good.id] });
    expect(res.status).toBe(200);
    expect((await res.json()).burns).toBe(1);
    expect(sends(QUEUES.burnTrack)).toEqual([[QUEUES.burnTrack, { trackId: track.id }, { ...JOB_OPTIONS, singletonKey: track.id }]]);
    expect((await getTrack(h.db, track.id))?.burnStatus).toBe("queued");
  });

  it("rolls the claim back and answers 503 when a job can't be queued", async () => {
    const { sessionId, good } = await twoClips();
    h.send.mockRejectedValueOnce(new Error("boom"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(sessionId, { clipIds: [good.id] });
    log.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect((await getClip(h.db, good.id))?.renderStatus).toBe("none");
    expect((await post(sessionId, { clipIds: [good.id] })).status).toBe(200);
  });

  it("checks stop counting once the clip is trimmed away from its moment's bounds (R28)", async () => {
    const { sessionId, good } = await twoClips();
    await updateClip(h.db, good.id, { warningsAck: true }, "user");
    await updateClip(h.db, good.id, { endMs: 29_000 }, "user"); // resets the acknowledgement too
    const res = await post(sessionId, { clipIds: [good.id] });
    expect(res.status).toBe(400);
    expect((await res.json()).blocked).toEqual([{ clipId: good.id, failing: ["argument", "context", "flags"] }]);
    await updateClip(h.db, good.id, { warningsAck: true }, "user");
    expect((await post(sessionId, { clipIds: [good.id] })).status).toBe(200);
  });

  it("an outdated subtitle track blocks the clip (R27)", async () => {
    const { sessionId, good } = await twoClips();
    const track = (await createTrack(h.db, good.id, "pt"))!;
    await setTrackCues(h.db, track.id, [{ startMs: 0, endMs: 1000, original: "Hi", text: "Olá", missing: false }], "ready", { startMs: 1, endMs: 2 });
    expect((await getTrack(h.db, track.id))?.status).toBe("outdated");
    const res = await post(sessionId, { clipIds: [good.id] });
    expect(res.status).toBe(400);
    expect((await res.json()).blocked).toEqual([{ clipId: good.id, failing: ["subtitles"] }]);
  });

  it("rejects bad bodies, unknown clips and unready sessions", async () => {
    const { sessionId, good } = await twoClips();
    expect((await post(sessionId, { clipIds: [] })).status).toBe(400);
    expect((await post(sessionId, { clipIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    expect((await post("nope", { clipIds: [good.id] })).status).toBe(404);
    await updateSession(h.db, sessionId, { stage: "finding_moments" });
    expect((await post(sessionId, { clipIds: [good.id] })).status).toBe(409);
  });
});
