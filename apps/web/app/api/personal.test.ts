import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JOB_OPTIONS, OWNER_ID, QUEUES } from "@digestor/core";
import {
  createCustomPerson, failFindMore, getFindMore, replaceAiAttributions, setHumanAttribution, claimFindMore,
  createClip, createTrack, deleteClip, failTrack, getClip, getTrack, listClips, setTrackBurnStatus, listSelections, setMomentChecks, setTrackCues, updateSession,
  approveTrack, updateClip, setSelection,
} from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { seedReadySession } from "@/test/personalFixture";
import { PUT as putSelection } from "./moments/[id]/selection/route";
import { GET as getSelections } from "./sessions/[id]/selections/route";
import { POST as confirm } from "./sessions/[id]/clips/route";
import { PATCH as patchClip } from "./clips/[id]/route";
import { POST as undo } from "./clips/[id]/undo/route";
import { POST as postTrack } from "./clips/[id]/tracks/route";
import { PATCH as patchTrack } from "./tracks/[id]/route";
import { GET as getFindMoreRoute, POST as postFindMore } from "./sessions/[id]/find-more/route";

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

describe("GET /api/sessions/[id]/selections", () => {
  it("returns the owner's selections, 404 for a bad id and 409 for a session that isn't ready", async () => {
    const { sessionId, moments } = await seedReadySession(h.db);
    await putSelection(req({ status: "rejected" }, "PUT"), ctx(moments[0]!.id));
    const res = await getSelections(new Request("http://localhost/x"), ctx(sessionId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ selections: { [moments[0]!.id]: "rejected" } });
    expect((await getSelections(new Request("http://localhost/x"), ctx("nope"))).status).toBe(404);
    expect((await getSelections(new Request("http://localhost/x"), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    await updateSession(h.db, sessionId, { stage: "failed" });
    expect((await getSelections(new Request("http://localhost/x"), ctx(sessionId))).status).toBe(409);
  });
});

describe("PUT /api/moments/[id]/selection", () => {
  it("selection approve enqueues one check when checks are missing", async () => {
    const { moments } = await seedReadySession(h.db);
    const m = moments[0]!;
    const res = await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "approved" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.checkMoment, { momentId: m.id }, JOB_OPTIONS);
    // skipped does not enqueue; checks already present do not enqueue
    await putSelection(req({ status: "rejected" }, "PUT"), ctx(m.id));
    await setMomentChecks(h.db, m.id, cleanChecks);
    await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("neutral is no longer a status (400); rejected (shown as Skip) is accepted", async () => {
    const { moments } = await seedReadySession(h.db);
    const m = moments[0]!;
    expect((await putSelection(req({ status: "neutral" }, "PUT"), ctx(m.id))).status).toBe(400);
    expect((await putSelection(req({ status: "rejected" }, "PUT"), ctx(m.id))).status).toBe(200);
  });

  it("null clears the selection; bad bodies and unready sessions are refused", async () => {
    const { sessionId, moments } = await seedReadySession(h.db);
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
    const { sessionId, moments } = await seedReadySession(h.db, [[10_000, 30_000], [40_000, 60_000], [70_000, 90_000]]);
    const [a, b, c] = moments as [(typeof moments)[0], (typeof moments)[0], (typeof moments)[0]];
    // selections set directly (an approve through the route would already have claimed and sent the checks)
    await setSelection(h.db, OWNER_ID, a.id, "approved");
    await setSelection(h.db, OWNER_ID, b.id, "approved");
    await setSelection(h.db, OWNER_ID, c.id, "rejected");

    const ids = [a.id, b.id, c.id];
    const first = await (await confirm(req({ momentIds: ids }), ctx(sessionId))).json();
    expect(first.clips.map((x: { momentId: string }) => x.momentId).sort()).toEqual([a.id, b.id].sort());
    expect(first.clips.find((x: { momentId: string }) => x.momentId === a.id)).toMatchObject({ startMs: 10_000, endMs: 30_000 });
    // checks missing for both moments → one check each
    expect(h.send.mock.calls.filter((call) => call[0] === QUEUES.checkMoment)).toHaveLength(2);

    const second = await (await confirm(req({ momentIds: ids }), ctx(sessionId))).json();
    expect(h.send.mock.calls.filter((call) => call[0] === QUEUES.checkMoment)).toHaveLength(2); // claimed: not sent again
    expect(second.clips.map((x: { id: string }) => x.id).sort()).toEqual(first.clips.map((x: { id: string }) => x.id).sort());
    expect(await listClips(h.db, OWNER_ID, sessionId)).toHaveLength(2);
  });

  it("refuses with the removal copy once the video is gone", async () => {
    const { sessionId, moments } = await seedReadySession(h.db);
    await putSelection(req({ status: "approved" }, "PUT"), ctx(moments[0]!.id));
    await updateSession(h.db, sessionId, { videoDeletedAt: new Date() });
    const res = await confirm(req({ momentIds: [moments[0]!.id] }), ctx(sessionId));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The video was removed after 14 days. Re-upload it to make new clips." });
    expect(await listClips(h.db, OWNER_ID, sessionId)).toHaveLength(0);
  });
});

async function clipFor(range: [number, number] = [10_000, 30_000]) {
  const { sessionId, moments } = await seedReadySession(h.db, [range]);
  const clip = await createClip(h.db, { sessionId, ownerId: OWNER_ID, momentId: moments[0]!.id, startMs: range[0], endMs: range[1], actor: "user" });
  return { sessionId, clip };
}

describe("POST /api/sessions/[id]/clips (parallel)", () => {
  it("two parallel confirms give exactly one clip per approved moment", async () => {
    const { sessionId, moments } = await seedReadySession(h.db, [[10_000, 30_000], [40_000, 60_000]]);
    for (const m of moments) await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    const body = { momentIds: moments.map((m) => m.id) };
    const [a, b] = await Promise.all([confirm(req(body), ctx(sessionId)), confirm(req(body), ctx(sessionId))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await listClips(h.db, OWNER_ID, sessionId)).toHaveLength(2);
    const ids = (r: { clips: { id: string }[] }) => r.clips.map((c) => c.id).sort();
    expect(ids(await a.json())).toEqual(ids(await b.json()));
  });
});

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
    // undo the creation: the clip is soft-deleted; with every event undone, a further undo has nothing to do (409)
    await undo(req({}), ctx(clip.id));
    expect(await getClip(h.db, clip.id)).toBeNull();
    expect((await undo(req({}), ctx(clip.id))).status).toBe(409);
    expect((await undo(req({}), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });

  it("undo restores a deleted clip (R4)", async () => {
    const { clip } = await clipFor();
    await deleteClip(h.db, clip.id, "user");
    expect(await getClip(h.db, clip.id)).toBeNull();
    const res = await undo(req({}), ctx(clip.id));
    expect(res.status).toBe(200);
    expect((await res.json()).deletedAt).toBeNull();
    expect(await getClip(h.db, clip.id)).not.toBeNull();
  });

  it("undo with ifActor ask only reverts a change the Ask agent made last (R26)", async () => {
    const { sessionId, moments } = await seedReadySession(h.db);
    const m = moments[0]!;
    const guarded = { ifActor: "ask" };
    // created by ask, untouched: undone
    const mine = await createClip(h.db, { sessionId, ownerId: OWNER_ID, momentId: m.id, startMs: 10_000, endMs: 30_000, actor: "ask" });
    expect((await undo(req(guarded), ctx(mine.id))).status).toBe(200);
    expect(await getClip(h.db, mine.id)).toBeNull();
    // the user brought it back (latest event is theirs? the undone create is skipped; nothing of ask's remains)
    expect((await undo(req(guarded), ctx(mine.id))).status).toBe(409);
    // created by ask, then edited by the user: latest event is the user's
    const edited = await createClip(h.db, { sessionId, ownerId: OWNER_ID, momentId: m.id, startMs: 10_000, endMs: 30_000, actor: "ask" });
    await patchClip(req({ extend: "next" }, "PATCH"), ctx(edited.id));
    const refused = await undo(req(guarded), ctx(edited.id));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("There is nothing to undo.");
    expect((await getClip(h.db, edited.id))!.endMs).toBeGreaterThan(30_000); // the user's edit stays
    // created by ask, deleted by the user: not undone by the drawer
    const gone = await createClip(h.db, { sessionId, ownerId: OWNER_ID, momentId: m.id, startMs: 10_000, endMs: 30_000, actor: "ask" });
    await deleteClip(h.db, gone.id, "user");
    expect((await undo(req(guarded), ctx(gone.id))).status).toBe(409);
    expect(await getClip(h.db, gone.id)).toBeNull();
    // without the body the old behaviour stays: Prepare's Undo restores it
    expect((await undo(req({}), ctx(gone.id))).status).toBe(200);
    expect(await getClip(h.db, gone.id)).not.toBeNull();
  });

  it("a clip owned by someone else is a 404 on every clip and track route", async () => {
    const { sessionId, clip: mine } = await clipFor();
    const other = await createClip(h.db, { sessionId, ownerId: "someone-else", startMs: 10_000, endMs: 30_000, actor: "user" });
    const track = (await createTrack(h.db, other.id, "pt"))!;
    expect((await patchClip(req({ warningsAck: true }, "PATCH"), ctx(other.id))).status).toBe(404);
    expect((await undo(req({}), ctx(other.id))).status).toBe(404);
    expect((await postTrack(req({ language: "fr" }), ctx(other.id))).status).toBe(404);
    expect((await patchTrack(req({ burn: true }, "PATCH"), ctx(track.id))).status).toBe(404);
    expect((await patchClip(req({ warningsAck: true }, "PATCH"), ctx(mine.id))).status).toBe(200);
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

  it("adding a language again replaces a failed track and queues one prepare job for the new one", async () => {
    const { clip } = await clipFor();
    const first = await (await postTrack(req({ language: "de" }), ctx(clip.id))).json();
    await failTrack(h.db, first.id, "ANTHROPIC_API_KEY is not set on the server.");
    h.send.mockClear();
    const res = await postTrack(req({ language: "de" }), ctx(clip.id));
    expect(res.status).toBe(201);
    const second = await res.json();
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("preparing");
    expect(await getTrack(h.db, first.id)).toBeNull();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.prepareTrack, { trackId: second.id }, { ...JOB_OPTIONS, singletonKey: second.id });
  });

  it("a ready (or preparing) track in that language still answers 409", async () => {
    const { clip } = await clipFor();
    const t = await (await postTrack(req({ language: "it" }), ctx(clip.id))).json();
    expect((await postTrack(req({ language: "it" }), ctx(clip.id))).status).toBe(409);
    await setTrackCues(h.db, t.id, [{ startMs: 0, endMs: 1000, original: "a", text: "b", missing: false }], "ready");
    h.send.mockClear();
    const res = await postTrack(req({ language: "it" }), ctx(clip.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This clip already has subtitles in that language." });
    expect(h.send).not.toHaveBeenCalled();
    expect((await getTrack(h.db, t.id))?.status).toBe("ready");
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

  it("burn:false drops a finished burn and is refused while one is being made", async () => {
    const { clip } = await clipFor();
    const track = (await createTrack(h.db, clip.id, "pt"))!;
    await setTrackBurnStatus(h.db, track.id, "done");
    expect(await (await patchTrack(req({ burn: false }, "PATCH"), ctx(track.id))).json()).toMatchObject({ burnStatus: "none" });
    for (const status of ["queued", "rendering"] as const) {
      await setTrackBurnStatus(h.db, track.id, status);
      const res = await patchTrack(req({ burn: false }, "PATCH"), ctx(track.id));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "The burned-in version is being made; try again when it finishes." });
      expect((await getTrack(h.db, track.id))?.burnStatus).toBe(status);
    }
  });

  it("burn requests toggle and need no approval until export", async () => {
    const { clip } = await clipFor();
    const track = (await createTrack(h.db, clip.id, "pt"))!;
    expect(await (await patchTrack(req({ burn: true }, "PATCH"), ctx(track.id))).json()).toMatchObject({ burnStatus: "stale" });
    expect(await (await patchTrack(req({ burn: false }, "PATCH"), ctx(track.id))).json()).toMatchObject({ burnStatus: "none" });
    expect((await patchTrack(req({ edits: [{ i: 0, text: "x" }] }, "PATCH"), ctx(track.id))).status).toBe(409); // still preparing
  });
});

describe("moment checks are claimed in the database (R29)", () => {
  it("approve, skip, approve again sends one check while the claim is fresh", async () => {
    const { moments } = await seedReadySession(h.db);
    const m = moments[0]!;
    await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    await putSelection(req({ status: "rejected" }, "PUT"), ctx(m.id));
    await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    expect(h.send.mock.calls.filter((c) => c[0] === QUEUES.checkMoment)).toHaveLength(1);
  });

  it("a send that fails releases the claim, so the next approve sends", async () => {
    const { moments } = await seedReadySession(h.db);
    const m = moments[0]!;
    h.send.mockRejectedValueOnce(new Error("boom"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id))).status).toBe(200);
    log.mockRestore();
    await putSelection(req({ status: "approved" }, "PUT"), ctx(m.id));
    expect(h.send.mock.calls.filter((c) => c[0] === QUEUES.checkMoment)).toHaveLength(2);
  });
});

describe("tracks follow the cut (R27)", () => {
  it("Rebuild replaces an outdated track and queues one prepare job", async () => {
    const { clip } = await clipFor();
    const old = (await createTrack(h.db, clip.id, "pt"))!;
    await setTrackCues(h.db, old.id, [{ startMs: 0, endMs: 1000, original: "a", text: "b", missing: false }], "ready", { startMs: 10_000, endMs: 30_000 });
    await approveTrack(h.db, old.id);
    const trimmed = await patchClip(req({ extend: "next" }, "PATCH"), ctx(clip.id));
    expect(trimmed.status).toBe(200);
    expect(await getTrack(h.db, old.id)).toMatchObject({ status: "outdated", approvedAt: null });
    h.send.mockClear();
    const res = await postTrack(req({ language: "pt" }), ctx(clip.id));
    expect(res.status).toBe(201);
    const fresh = await res.json();
    expect(fresh).toMatchObject({ language: "pt", status: "preparing" });
    expect(await getTrack(h.db, old.id)).toBeNull();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.prepareTrack, { trackId: fresh.id }, { ...JOB_OPTIONS, singletonKey: fresh.id });
  });

  it("an outdated track can't be edited or approved", async () => {
    const { clip } = await clipFor();
    const tr = (await createTrack(h.db, clip.id, "pt"))!;
    await setTrackCues(h.db, tr.id, [{ startMs: 0, endMs: 1000, original: "a", text: "b", missing: false }], "ready", { startMs: 10_000, endMs: 30_000 });
    await updateClip(h.db, clip.id, { endMs: 40_000 }, "user");
    expect((await patchTrack(req({ approve: true }, "PATCH"), ctx(tr.id))).status).toBe(409);
    expect((await patchTrack(req({ edits: [{ i: 0, text: "x" }] }, "PATCH"), ctx(tr.id))).status).toBe(409);
  });
});

describe("kept clips are frozen once the video is removed (R30)", () => {
  const REMOVED = { error: "The video was removed after 14 days. Re-upload it to make new clips." };

  it("bounds, extend, format, crop, credit, undo and track changes answer 409; acknowledgements still save", async () => {
    const { sessionId, clip } = await clipFor();
    await updateClip(h.db, clip.id, { endMs: 40_000 }, "user"); // something to undo
    const tr = (await createTrack(h.db, clip.id, "pt"))!;
    await setTrackCues(h.db, tr.id, [{ startMs: 0, endMs: 1000, original: "a", text: "b", missing: false }], "ready", { startMs: 10_000, endMs: 40_000 });
    await updateSession(h.db, sessionId, { videoDeletedAt: new Date() });
    const before = await getClip(h.db, clip.id);

    for (const body of [
      { start: "00:00:10", end: "00:00:30" }, { extend: "next" }, { format: "9:16" }, { cropOffset: 0.5 },
      { credit: "TV" }, { noCreditNeeded: true },
    ]) {
      const res = await patchClip(req(body, "PATCH"), ctx(clip.id));
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(await res.json()).toEqual(REMOVED);
    }
    const u = await undo(req({}), ctx(clip.id));
    expect(u.status).toBe(409);
    expect(await u.json()).toEqual(REMOVED);
    for (const body of [{ edits: [{ i: 0, text: "x" }] }, { approve: true }, { burn: true }]) {
      const res = await patchTrack(req(body, "PATCH"), ctx(tr.id));
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(await res.json()).toEqual(REMOVED);
    }
    expect(await getClip(h.db, clip.id)).toMatchObject({ startMs: before!.startMs, endMs: before!.endMs, format: before!.format, credit: before!.credit });
    expect(await getTrack(h.db, tr.id)).toMatchObject({ approvedAt: null, burnStatus: "none" });

    expect((await patchClip(req({ warningsAck: true }, "PATCH"), ctx(clip.id))).status).toBe(200);
    expect((await patchClip(req({ protectedAck: true }, "PATCH"), ctx(clip.id))).status).toBe(200);
  });
});

describe("/api/sessions/[id]/find-more", () => {
  async function named(confirm = true, profile = "interview") {
    const seeded = await seedReadySession(h.db, [[10_000, 30_000]], profile);
    const person = await createCustomPerson(h.db, { displayName: "Tralli", createdBy: OWNER_ID });
    if (confirm) await setHumanAttribution(h.db, { sessionId: seeded.sessionId, speakerId: "A", startMs: null, endMs: null, personId: person.id, ownerId: OWNER_ID });
    else {
      await replaceAiAttributions(h.db, seeded.sessionId, "transcript", [
        { speakerId: "A", startMs: null, endMs: null, personId: person.id, status: "proposed", confidence: 0.6, evidence: { kind: "none" } },
      ]);
    }
    return { ...seeded, personId: person.id };
  }
  const get = (sessionId: string, personId: string) => getFindMoreRoute(new Request(`http://localhost/x?personId=${personId}`), ctx(sessionId));

  it("202 and one send of moment.find_more with JOB_OPTIONS; 409 while it runs", async () => {
    const { sessionId, analysisId, personId } = await named();
    expect(await (await get(sessionId, personId)).json()).toEqual({ status: "none", momentCount: 0, error: null, requestId: null });
    const res = await postFindMore(req({ personId }), ctx(sessionId));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending" });
    const row = (await getFindMore(h.db, { ownerId: OWNER_ID, analysisId, personId }))!;
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.findMore, { requestId: row.id }, JOB_OPTIONS);
    expect(await (await get(sessionId, personId)).json()).toEqual({ status: "pending", momentCount: 0, error: null, requestId: row.id });

    await claimFindMore(h.db, row.id);
    const again = await postFindMore(req({ personId }), ctx(sessionId));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Already looking for more moments with this person." });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a failed send puts the row back to failed and answers 503", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sessionId, analysisId, personId } = await named();
    h.send.mockRejectedValueOnce(new Error("pg down"));
    const res = await postFindMore(req({ personId }), ctx(sessionId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect(await getFindMore(h.db, { ownerId: OWNER_ID, analysisId, personId })).toMatchObject({
      status: "failed", error: "Couldn't queue the job. Please try again.",
    });
    expect(await (await get(sessionId, personId)).json()).toMatchObject({ status: "failed", error: "Couldn't queue the job. Please try again." });
    expect((await postFindMore(req({ personId }), ctx(sessionId))).status).toBe(202); // asking again works
    err.mockRestore();
  });

  it("refuses bad input, a person who isn't listed, an unconfirmed person in a sensitive profile and a session that isn't ready", async () => {
    const { sessionId, personId } = await named(false);
    expect((await postFindMore(req({}), ctx(sessionId))).status).toBe(400);
    expect((await postFindMore(req({ personId: "nope" }), ctx(sessionId))).status).toBe(400);
    expect((await postFindMore(req({ personId }), ctx("nope"))).status).toBe(404);
    const stranger = await createCustomPerson(h.db, { displayName: "Nobody", createdBy: OWNER_ID });
    expect((await postFindMore(req({ personId: stranger.id }), ctx(sessionId))).status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
    const trial = await named(false, "trial"); // a sensitive profile doesn't list an unconfirmed name
    expect((await postFindMore(req({ personId: trial.personId }), ctx(trial.sessionId))).status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
    await updateSession(h.db, sessionId, { stage: "finding_moments" });
    expect((await postFindMore(req({ personId }), ctx(sessionId))).status).toBe(409);
  });
});
