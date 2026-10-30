import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JOB_OPTIONS, OWNER_ID, QUEUES } from "@digestor/core";
import {
  createClip, createTrack, getClip, listClips, listSelections, setMomentChecks, setTrackCues, updateSession,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { readySession } from "@/test/personalFixture";
import { PUT as putSelection } from "./moments/[id]/selection/route";
import { POST as confirm } from "./sessions/[id]/clips/route";
import { PATCH as patchClip } from "./clips/[id]/route";
import { POST as undo } from "./clips/[id]/undo/route";
import { POST as postTrack } from "./clips/[id]/tracks/route";
import { PATCH as patchTrack } from "./tracks/[id]/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => h.send.mockClear());

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown, method = "POST") => new Request("http://localhost/x", { method, body: JSON.stringify(body) });
const cleanChecks = {
  argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
};

describe("PUT /api/moments/[id]/selection", () => {
  it("selection approve enqueues one check when checks are missing", async () => {
    const { moments } = await readySession(h.db);
    const m = moments[0]!;
    const res = await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "approved" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.checkMoment, { momentId: m.id }, { ...JOB_OPTIONS, singletonKey: m.id });
    // neutral does not enqueue; checks already present do not enqueue
    await putSelection(req({ status: "neutral" }, "PUT"), ctx(m.id));
    await setMomentChecks(h.db, m.id, cleanChecks);
    await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("null clears the selection; bad bodies and unready sessions are refused", async () => {
    const { sessionId, moments } = await readySession(h.db);
    const m = moments[0]!;
    await putSelection(req({ status: "rejected" }, "PUT"), ctx(m.id));
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({ [m.id]: "rejected" });
    expect((await putSelection(req({ status: null }, "PUT"), ctx(m.id))).status).toBe(200);
    expect(await listSelections(h.db, OWNER_ID, sessionId)).toEqual({});
    expect((await putSelection(req({ status: "maybe" }, "PUT"), ctx(m.id))).status).toBe(400);
    expect((await putSelection(req({ status: "approved" }, "PUT"), ctx("nope"))).status).toBe(404);
    await updateSession(h.db, sessionId, { stage: "finding_moments" });
    const res = await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This video isn't ready yet." });
  });
});

describe("POST /api/sessions/[id]/clips", () => {
  it("confirm creates one clip per approved moment and is idempotent", async () => {
    const { sessionId, moments } = await readySession(h.db, [[10_000, 30_000], [40_000, 60_000], [70_000, 90_000]]);
    const [a, b, c] = moments as [(typeof moments)[0], (typeof moments)[0], (typeof moments)[0]];
    await putSelection(req({ status: "approved" }, "PUT"), ctx(a.id));
    await putSelection(req({ status: "approved" }, "PUT"), ctx(b.id));
    await putSelection(req({ status: "rejected" }, "PUT"), ctx(c.id));
    h.send.mockClear();

    const ids = [a.id, b.id, c.id];
    const first = await (await confirm(req({ momentIds: ids }), ctx(sessionId))).json();
    expect(first.clips.map((x: { momentId: string }) => x.momentId).sort()).toEqual([a.id, b.id].sort());
    expect(first.clips.find((x: { momentId: string }) => x.momentId === a.id)).toMatchObject({ startMs: 10_000, endMs: 30_000 });
    // checks missing for both moments → one check each
    expect(h.send.mock.calls.filter((call) => call[0] === QUEUES.checkMoment)).toHaveLength(2);

    const second = await (await confirm(req({ momentIds: ids }), ctx(sessionId))).json();
    expect(second.clips.map((x: { id: string }) => x.id).sort()).toEqual(first.clips.map((x: { id: string }) => x.id).sort());
    expect(await listClips(h.db, OWNER_ID, sessionId)).toHaveLength(2);
  });

  it("refuses with the removal copy once the video is gone", async () => {
    const { sessionId, moments } = await readySession(h.db);
    await putSelection(req({ status: "approved" }, "PUT"), ctx(moments[0]!.id));
    await updateSession(h.db, sessionId, { videoDeletedAt: new Date() });
    const res = await confirm(req({ momentIds: [moments[0]!.id] }), ctx(sessionId));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The video was removed after 14 days. Re-upload it to make new clips." });
    expect(await listClips(h.db, OWNER_ID, sessionId)).toHaveLength(0);
  });
});

async function clipFor(range: [number, number] = [10_000, 30_000]) {
  const { sessionId, moments } = await readySession(h.db, [range]);
  const clip = await createClip(h.db, { sessionId, ownerId: OWNER_ID, momentId: moments[0]!.id, startMs: range[0], endMs: range[1], actor: "user" });
  return { sessionId, clip };
}

describe("PATCH /api/clips/[id]", () => {
  it("trim snaps and reports the v1 errors", async () => {
    const { clip } = await clipFor();
    const ok = await patchClip(req({ start: "00:00:20", end: "00:00:51" }, "PATCH"), ctx(clip.id));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ startMs: 19_900, endMs: 51_000 - 1000 });
    const bad = await patchClip(req({ start: "1:2:x", end: "00:00:30" }, "PATCH"), ctx(clip.id));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Use the format hh:mm:ss or hh:mm:ss.s" });
    const range = await patchClip(req({ start: "00:00:30", end: "00:00:20" }, "PATCH"), ctx(clip.id));
    expect(range.status).toBe(400);
    expect(await range.json()).toEqual({ error: "End must be after start and within the video (hh:mm:ss)" });
    expect((await patchClip(req({ start: "00:00:10", end: "00:05:00" }, "PATCH"), ctx(clip.id))).status).toBe(400);
  });

  it("extend moves the end to the next sentence end", async () => {
    const { clip } = await clipFor();
    const res = await patchClip(req({ extend: "next" }, "PATCH"), ctx(clip.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ startMs: 10_000, endMs: 40_000 });
    expect((await getClip(h.db, clip.id))?.endMs).toBe(40_000);
  });

  it("format and crop: validates, clamps cropOffset to -1…1", async () => {
    const { clip } = await clipFor();
    const res = await patchClip(req({ format: "9:16", cropOffset: 3 }, "PATCH"), ctx(clip.id));
    expect(await res.json()).toMatchObject({ format: "9:16", cropOffset: 1 });
    expect(await (await patchClip(req({ cropOffset: -7.5 }, "PATCH"), ctx(clip.id))).json()).toMatchObject({ cropOffset: -1 });
    for (const body of [{ cropOffset: "NaN" }, { cropOffset: null }, { format: "4:3" }, { format: "16:9", cropOffset: "0.5" }, {}]) {
      expect((await patchClip(req(body, "PATCH"), ctx(clip.id))).status).toBe(400);
    }
    // JSON can't carry NaN/Infinity; a raw body with them is not valid JSON and is refused too
    const raw = new Request("http://localhost/x", { method: "PATCH", body: '{"cropOffset": NaN}' });
    expect((await patchClip(raw, ctx(clip.id))).status).toBe(400);
  });

  it("credit and acknowledgements", async () => {
    const { clip } = await clipFor();
    expect(await (await patchClip(req({ credit: "  Parliament TV " }, "PATCH"), ctx(clip.id))).json()).toMatchObject({ credit: "Parliament TV" });
    expect(await (await patchClip(req({ credit: "" }, "PATCH"), ctx(clip.id))).json()).toMatchObject({ credit: null });
    expect(await (await patchClip(req({ noCreditNeeded: true }, "PATCH"), ctx(clip.id))).json()).toMatchObject({ noCreditNeeded: true });
    expect(await (await patchClip(req({ warningsAck: true }, "PATCH"), ctx(clip.id))).json()).toMatchObject({ warningsAck: true });
    expect(await (await patchClip(req({ protectedAck: true }, "PATCH"), ctx(clip.id))).json()).toMatchObject({ protectedAck: true });
    expect((await patchClip(req({ warningsAck: true, protectedAck: true }, "PATCH"), ctx(clip.id))).status).toBe(400);
  });

  it("undo reverts the last change and brings back a deleted clip", async () => {
    const { clip } = await clipFor();
    await patchClip(req({ extend: "next" }, "PATCH"), ctx(clip.id));
    const res = await undo(req({}), ctx(clip.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ endMs: 30_000 });
    // undo the creation: soft-deleted, then undo again restores nothing more to undo → 409 or brings it back
    await undo(req({}), ctx(clip.id));
    expect(await getClip(h.db, clip.id)).toBeNull();
    expect((await undo(req({}), ctx(clip.id))).status).toBe(409);
    expect((await undo(req({}), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });
});

describe("tracks", () => {
  it("creates a track for an offered language, once, and queues the prepare job", async () => {
    const { clip } = await clipFor();
    const res = await postTrack(req({ language: "pt" }), ctx(clip.id));
    expect(res.status).toBe(201);
    const track = await res.json();
    expect(h.send).toHaveBeenCalledWith(QUEUES.prepareTrack, { trackId: track.id }, { ...JOB_OPTIONS, singletonKey: track.id });
    expect((await postTrack(req({ language: "pt" }), ctx(clip.id))).status).toBe(409);
    expect((await postTrack(req({ language: "xx" }), ctx(clip.id))).status).toBe(400);
    expect((await postTrack(req({ language: "en" }), ctx(clip.id))).status).toBe(201); // also the session language
  });

  it("rolls the track back when the job can't be queued", async () => {
    const { clip } = await clipFor();
    h.send.mockRejectedValueOnce(new Error("boom"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await postTrack(req({ language: "fr" }), ctx(clip.id));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    expect((await postTrack(req({ language: "fr" }), ctx(clip.id))).status).toBe(201);
  });

  it("approve refuses a track with empty cues", async () => {
    const { clip } = await clipFor();
    const track = (await createTrack(h.db, clip.id, "pt"))!;
    const cue = (text: string) => ({ startMs: 0, endMs: 1000, original: "Hello", text, missing: text === "" });
    await setTrackCues(h.db, track.id, [cue("Olá"), cue("")], "ready");
    const refused = await patchTrack(req({ approve: true }, "PATCH"), ctx(track.id));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Fill every subtitle line before approving." });
    const edited = await patchTrack(req({ edits: [{ i: 1, text: "Mundo" }] }, "PATCH"), ctx(track.id));
    expect(edited.status).toBe(200);
    const ok = await patchTrack(req({ approve: true }, "PATCH"), ctx(track.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).approvedAt).not.toBeNull();
  });

  it("burn requests toggle and need no approval until export", async () => {
    const { clip } = await clipFor();
    const track = (await createTrack(h.db, clip.id, "pt"))!;
    expect(await (await patchTrack(req({ burn: true }, "PATCH"), ctx(track.id))).json()).toMatchObject({ burnStatus: "stale" });
    expect(await (await patchTrack(req({ burn: false }, "PATCH"), ctx(track.id))).json()).toMatchObject({ burnStatus: "none" });
    expect((await patchTrack(req({ edits: [{ i: 0, text: "x" }] }, "PATCH"), ctx(track.id))).status).toBe(409); // still preparing
  });
});
