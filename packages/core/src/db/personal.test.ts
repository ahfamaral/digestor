import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { completeAnalysisVersion, saveMoments, startAnalysisVersion } from "./analysis.ts";
import { createSession, type Session } from "./repo.ts";
import { sql } from "drizzle-orm";
import { clipEvents, subtitleTracks } from "./schema.ts";
import {
  addAskMessage, addProblemReport, approveTrack, claimClipRender, claimTrackBurn, createAskAction, createClip,
  createPersonalMoment, burnSignature, createTrack, deleteClip, editTrackCues, finishAskMessage, finishClipRender,
  finishTrackBurn, setTrackBurnStatus, getAskMessage, getClip, getTrack, listAskMessages, listClips, listPersonalMoments, listProblemReports, listSelections,
  countSelectionsByAnalysis,
  resolveAskAction, deleteTrack, deleteFailedTrack, failTrack, getClipAny, requestTrackBurn, setSelection, setTrackCues, undoLastEvent, updateClip,
  claimMomentCheck, releaseMomentCheck, claimAskMessage, releaseAskMessage,
} from "./personal.ts";
import { getMoment, setMomentChecks } from "./analysis.ts";
import { moments as momentsTable } from "./schema.ts";
import type { TrackCue } from "../personalTypes.ts";

const OWNER = "owner";
let db: Db;
let close: () => Promise<void>;
let s: Session;
let analysisId: string;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions RESTART IDENTITY CASCADE");
  await pool.end();
  s = await createSession(db, { title: "T", source: "upload" });
  const v = await startAnalysisVersion(db, s.id, { profile: "interview", reason: "r", models: {}, promptVersions: {} });
  analysisId = v.id;
});

const newClip = () => createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 10_000, endMs: 50_000, actor: "user" });
const cue = (text: string, over: Partial<TrackCue> = {}): TrackCue => ({
  startMs: 0, endMs: 1000, original: "Hello", text, missing: text === "", ...over,
});

describe("personal moments and selections", () => {
  it("createPersonalMoment derives granularity from length", async () => {
    const p = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 0, endMs: 90_000, title: "Mine", origin: "user" });
    expect(p).toMatchObject({ granularity: "passage", relevance: 0, highlights: [], ownerId: OWNER, origin: "user" });
    const x = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 0, endMs: 10_000, title: "Short", origin: "ask" });
    expect(x.granularity).toBe("punchline");
    const far = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 0, endMs: 3_000_000, title: "Huge", origin: "user" });
    expect(far.granularity).toBe("exchange");
    expect((await listPersonalMoments(db, OWNER, analysisId)).map((m) => m.title).sort()).toEqual(["Huge", "Mine", "Short"]);
    expect(await listPersonalMoments(db, "someone-else", analysisId)).toEqual([]);
  });

  it("setSelection upserts and null deletes", async () => {
    const [m] = await saveMoments(db, analysisId, [
      { topicId: null, granularity: "passage", startMs: 0, endMs: 40_000, title: "M", why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai", highlights: [] },
    ]);
    const id = m!.id;
    await setSelection(db, OWNER, id, "approved");
    await setSelection(db, OWNER, id, "rejected");
    expect(await listSelections(db, OWNER, s.id)).toEqual({ [id]: "rejected" });
    await setSelection(db, OWNER, id, null);
    expect(await listSelections(db, OWNER, s.id)).toEqual({});
    await completeAnalysisVersion(db, analysisId);
  });

  it("countSelectionsByAnalysis counts the owner's selections per analysis version of the session", async () => {
    const row = (title: string) => ({
      topicId: null, granularity: "passage" as const, startMs: 0, endMs: 40_000, title, why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai" as const, highlights: [],
    });
    const [a1, a2] = await saveMoments(db, analysisId, [row("a1"), row("a2")]);
    await completeAnalysisVersion(db, analysisId);
    const v2 = await startAnalysisVersion(db, s.id, { profile: "interview", reason: "r", models: {}, promptVersions: {} });
    const [b1] = await saveMoments(db, v2.id, [row("b1")]);
    await setSelection(db, OWNER, a1!.id, "approved");
    await setSelection(db, OWNER, a2!.id, "rejected");
    await setSelection(db, OWNER, b1!.id, "neutral");
    await setSelection(db, "someone-else", b1!.id, "approved");
    const other = await createSession(db, { title: "Other", source: "upload" });
    const ov = await startAnalysisVersion(db, other.id, { profile: "interview", reason: "r", models: {}, promptVersions: {} });
    const [o1] = await saveMoments(db, ov.id, [row("o1")]);
    await setSelection(db, OWNER, o1!.id, "approved");

    const counts = await countSelectionsByAnalysis(db, OWNER, s.id);
    expect(counts.sort((x, y) => x.version - y.version)).toEqual([
      { analysisId, version: 1, count: 2 },
      { analysisId: v2.id, version: 2, count: 1 },
    ]);
    expect(await countSelectionsByAnalysis(db, "nobody", s.id)).toEqual([]);
  });
});

describe("clips", () => {
  it("createClip writes a create event; defaults are v2", async () => {
    const c = await newClip();
    expect(c).toMatchObject({ format: "16:9", cropOffset: 0, renderStatus: "none", deletedAt: null });
    const ev = await db.select().from(clipEvents).where(eq(clipEvents.clipId, c.id));
    expect(ev.map((e) => e.kind)).toEqual(["create"]);
    expect((await listClips(db, OWNER, s.id)).map((x) => x.id)).toEqual([c.id]);
  });

  it("updateClip records before/after and marks done renders stale", async () => {
    const c = await newClip();
    await claimClipRender(db, c.id);
    expect(await finishClipRender(db, c.id, { startMs: 10_000, endMs: 50_000, format: "16:9", cropOffset: 0, credit: null }, { renderKey: "k.mp4" })).toBe("done");
    const t = (await createTrack(db, c.id, "pt"))!;
    await db.execute(sqlBurnDone(t.id));
    const u = await updateClip(db, c.id, { startMs: 11_000 }, "user");
    expect(u.renderStatus).toBe("stale");
    const ev = (await db.select().from(clipEvents).where(eq(clipEvents.clipId, c.id))).find((e) => e.kind === "bounds")!;
    expect((ev.before as { startMs: number }).startMs).toBe(10_000);
    expect((ev.after as { startMs: number }).startMs).toBe(11_000);
    expect((await getTrack(db, t.id))!.burnStatus).toBe("stale");
  });

  it("format and crop changes write a format event", async () => {
    const c = await newClip();
    const u = await updateClip(db, c.id, { format: "9:16", cropOffset: 0.5 }, "ask");
    expect(u).toMatchObject({ format: "9:16", cropOffset: 0.5 });
    const ev = (await db.select().from(clipEvents).where(eq(clipEvents.clipId, c.id))).find((e) => e.kind === "format")!;
    expect(ev.actor).toBe("ask");
    expect(ev.before).toEqual({ format: "16:9", cropOffset: 0 });
  });

  it("undoLastEvent reverts bounds then create", async () => {
    const c = await newClip();
    await updateClip(db, c.id, { startMs: 12_000, endMs: 52_000 }, "user");
    const r = await undoLastEvent(db, c.id);
    expect(r).toMatchObject({ startMs: 10_000, endMs: 50_000 });
    await undoLastEvent(db, c.id);
    expect(await getClip(db, c.id)).toBeNull();
    expect(await listClips(db, OWNER, s.id)).toEqual([]);
    expect(await undoLastEvent(db, c.id)).toBeNull();
  });

  it("delete then undo restores the clip with its history", async () => {
    const c = await newClip();
    await updateClip(db, c.id, { endMs: 55_000 }, "user");
    await deleteClip(db, c.id, "user");
    expect(await getClip(db, c.id)).toBeNull();
    const back = await undoLastEvent(db, c.id);
    expect(back).toMatchObject({ id: c.id, endMs: 55_000, deletedAt: null });
    expect((await listClips(db, OWNER, s.id)).length).toBe(1);
    const ev = await db.select().from(clipEvents).where(eq(clipEvents.clipId, c.id));
    expect(ev.map((e) => e.kind).sort()).toEqual(["bounds", "create", "delete"]);
  });

  it("credit change during a render is stale; unchanged is done; credit change stales a done render", async () => {
    const c = await newClip();
    const geo = { startMs: 10_000, endMs: 50_000, format: "16:9" as const, cropOffset: 0, credit: null };
    await claimClipRender(db, c.id);
    await updateClip(db, c.id, { credit: "Parliament TV" }, "user");
    expect(await finishClipRender(db, c.id, geo, { renderKey: "k" })).toBe("stale");
    await claimClipRender(db, c.id);
    expect(await finishClipRender(db, c.id, { ...geo, credit: "Parliament TV" }, { renderKey: "k" })).toBe("done");
    await updateClip(db, c.id, { noCreditNeeded: true }, "user");
    expect((await getClip(db, c.id))!.renderStatus).toBe("stale");
  });

  it("claimClipRender is exclusive; finish is stale when bounds, format or crop changed", async () => {
    const c = await newClip();
    expect(await claimClipRender(db, c.id)).toBe(true);
    expect(await claimClipRender(db, c.id)).toBe(false);
    await updateClip(db, c.id, { cropOffset: 0.2 }, "user");
    expect(await finishClipRender(db, c.id, { startMs: 10_000, endMs: 50_000, format: "16:9", cropOffset: 0, credit: null }, { renderKey: "k" })).toBe("stale");
    expect((await getClip(db, c.id))!.renderKey).toBe("k");
    expect(await claimClipRender(db, c.id)).toBe(true);
  });
});

const sqlBurnDone = (id: string) => sql`update ${subtitleTracks} set burn_status = 'done' where id = ${id}`;

describe("tracks", () => {
  it("createTrack returns null if it exists", async () => {
    const c = await newClip();
    expect(await createTrack(db, c.id, "pt")).toMatchObject({ language: "pt", status: "preparing", cues: [] });
    expect(await createTrack(db, c.id, "pt")).toBeNull();
  });

  it("approveTrack refuses a track with empty cues", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("")], "ready");
    expect(await approveTrack(db, t.id)).toBe("missing_cues");
    await editTrackCues(db, t.id, [{ i: 0, text: "Olá" }]);
    expect(await approveTrack(db, t.id)).toBe("ok");
  });

  it("editTrackCues clears approval and recomputes missing", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi"), cue("Tchau")], "ready");
    await approveTrack(db, t.id);
    const e = await editTrackCues(db, t.id, [{ i: 1, text: "  " }]);
    expect(e.approvedAt).toBeNull();
    expect(e.cues.map((x) => x.missing)).toEqual([false, true]);
  });

  it("finishTrackBurn marks stale when cues changed during the burn", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready");
    expect(await claimTrackBurn(db, t.id)).toBe(false); // not approved
    await approveTrack(db, t.id);
    expect(await claimTrackBurn(db, t.id)).toBe(true);
    expect(await claimTrackBurn(db, t.id)).toBe(false);
    const geo = { startMs: 10_000, endMs: 50_000, format: "16:9" as const, cropOffset: 0, credit: null };
    const sig = burnSignature({ cues: [cue("Oi")] }, geo);
    await editTrackCues(db, t.id, [{ i: 0, text: "Olá" }]);
    expect(await finishTrackBurn(db, t.id, sig, "b.mp4")).toBe("stale");
    await approveTrack(db, t.id);
    await claimTrackBurn(db, t.id);
    expect(await finishTrackBurn(db, t.id, burnSignature({ cues: [cue("Olá")] }, geo), "b2.mp4")).toBe("done");
  });

  it("finishTrackBurn is stale when the clip is trimmed during the burn", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready");
    await approveTrack(db, t.id);
    await claimTrackBurn(db, t.id);
    const sig = burnSignature({ cues: [cue("Oi")] }, c);
    await updateClip(db, c.id, { startMs: 11_000 }, "user");
    expect(await finishTrackBurn(db, t.id, sig, "b.mp4")).toBe("stale");
    await setTrackBurnStatus(db, t.id, "none");
    await claimTrackBurn(db, t.id);
    const now = (await getClip(db, c.id))!;
    expect(await finishTrackBurn(db, t.id, burnSignature({ cues: [cue("Oi")] }, now), "b.mp4")).toBe("done");
  });

  it("setTrackCues stales a done burn", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await db.execute(sqlBurnDone(t.id));
    await setTrackCues(db, t.id, [cue("Oi")], "ready");
    expect((await getTrack(db, t.id))!.burnStatus).toBe("stale");
  });

  it("soft-deleted clips can't be claimed or finished", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready");
    await approveTrack(db, t.id);
    await deleteClip(db, c.id, "user");
    expect(await claimClipRender(db, c.id)).toBe(false);
    expect(await claimTrackBurn(db, t.id)).toBe(false);
    expect(await finishClipRender(db, c.id, { startMs: 10_000, endMs: 50_000, format: "16:9", cropOffset: 0, credit: null }, { renderKey: "k" })).toBeNull();
    expect(await finishTrackBurn(db, t.id, "x", "k")).toBeNull();
  });
});

describe("tracks follow the cut (R27) and checks need a fresh ack (R28)", () => {
  const built = { startMs: 10_000, endMs: 50_000 };

  it("prepare records the built range; a matching clip stays ready", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    const r = await setTrackCues(db, t.id, [cue("Oi")], "ready", built);
    expect(r).toMatchObject({ status: "ready", builtStartMs: 10_000, builtEndMs: 50_000 });
  });

  it("a prepare that finishes after the clip was trimmed is outdated at once", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await updateClip(db, c.id, { startMs: 12_000 }, "user");
    const r = await setTrackCues(db, t.id, [cue("Oi")], "ready", built);
    expect(r.status).toBe("outdated");
  });

  it("a bounds change outdates every ready track built for other bounds, clears approval and the warnings ack", async () => {
    const c = await newClip();
    await updateClip(db, c.id, { warningsAck: true }, "user");
    const a = (await createTrack(db, c.id, "pt"))!;
    const b = (await createTrack(db, c.id, "en"))!;
    const f = (await createTrack(db, c.id, "fr"))!;
    await setTrackCues(db, a.id, [cue("Oi")], "ready", built);
    await setTrackCues(db, b.id, [cue("Hi")], "ready", built);
    await approveTrack(db, a.id);
    await failTrack(db, f.id, "x");
    const u = await updateClip(db, c.id, { endMs: 48_000 }, "ask");
    expect(u.warningsAck).toBe(false);
    expect(await getTrack(db, a.id)).toMatchObject({ status: "outdated", approvedAt: null });
    expect((await getTrack(db, b.id))!.status).toBe("outdated");
    expect((await getTrack(db, f.id))!.status).toBe("failed");
  });

  it("format, crop and credit changes leave tracks and the ack alone", async () => {
    const c = await newClip();
    await updateClip(db, c.id, { warningsAck: true }, "user");
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready", built);
    const u = await updateClip(db, c.id, { format: "9:16", credit: "TV" }, "user");
    expect(u.warningsAck).toBe(true);
    expect((await getTrack(db, t.id))!.status).toBe("ready");
  });

  it("undo of a trim resets the ack and brings an outdated track back to ready (unapproved)", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready", built);
    await approveTrack(db, t.id);
    await updateClip(db, c.id, { startMs: 12_000 }, "user");
    await updateClip(db, c.id, { warningsAck: true }, "user");
    expect((await getTrack(db, t.id))!.status).toBe("outdated");
    const back = await undoLastEvent(db, c.id); // the ack is not an event: this undoes the trim
    expect(back).toMatchObject({ startMs: 10_000, warningsAck: false });
    expect(await getTrack(db, t.id)).toMatchObject({ status: "ready", approvedAt: null });
  });

  it("an outdated track can be replaced (Rebuild), unless its burn is being made", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready", built);
    await updateClip(db, c.id, { startMs: 12_000 }, "user");
    await setTrackBurnStatus(db, t.id, "rendering");
    expect(await deleteFailedTrack(db, t.id)).toBe(false);
    await setTrackBurnStatus(db, t.id, "stale");
    expect(await deleteFailedTrack(db, t.id)).toBe(true);
    expect(await getTrack(db, t.id)).toBeNull();
  });
});

describe("claimMomentCheck (R29)", () => {
  async function moment() {
    const [m] = await saveMoments(db, analysisId, [
      { topicId: null, granularity: "passage", startMs: 0, endMs: 40_000, title: "M", why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai", highlights: [] },
    ]);
    return m!.id;
  }
  const age = (id: string, minutes: number) =>
    db.update(momentsTable).set({ checksRequestedAt: new Date(Date.now() - minutes * 60_000) }).where(eq(momentsTable.id, id));

  it("claims once; a second claim within 10 minutes is refused", async () => {
    const id = await moment();
    const [a, b] = await Promise.all([claimMomentCheck(db, id), claimMomentCheck(db, id)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await claimMomentCheck(db, id)).toBe(false);
  });

  it("a claim older than 10 minutes can be taken again", async () => {
    const id = await moment();
    expect(await claimMomentCheck(db, id)).toBe(true);
    await age(id, 9);
    expect(await claimMomentCheck(db, id)).toBe(false);
    await age(id, 11);
    expect(await claimMomentCheck(db, id)).toBe(true);
  });

  it("never claims a moment that has checks; a released claim can be taken again", async () => {
    const id = await moment();
    expect(await claimMomentCheck(db, id)).toBe(true);
    await releaseMomentCheck(db, id);
    expect(await claimMomentCheck(db, id)).toBe(true);
    await setMomentChecks(db, id, {
      argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false,
    });
    await releaseMomentCheck(db, id);
    expect(await claimMomentCheck(db, id)).toBe(false);
    expect((await getMoment(db, id))!.checks).not.toBeNull();
  });
});

describe("ask and reports", () => {
  it("resolveAskAction only resolves pending once", async () => {
    const m = await addAskMessage(db, { sessionId: s.id, ownerId: OWNER, role: "assistant", text: "", status: "pending" });
    await finishAskMessage(db, m.id, { text: "Done", toolCalls: [{ name: "x" }], status: "done" });
    const a = await createAskAction(db, { messageId: m.id, kind: "bulk_selection", payload: { ids: [] } });
    expect(await resolveAskAction(db, a.id, "confirmed")).toBe(true);
    expect(await resolveAskAction(db, a.id, "dismissed")).toBe(false);
    const [got] = await listAskMessages(db, OWNER, s.id);
    expect(got).toMatchObject({ text: "Done", status: "done" });
    expect(got!.actions[0]!.status).toBe("confirmed");
    expect(await getAskMessage(db, m.id)).toMatchObject({ id: m.id, sessionId: s.id, role: "assistant", status: "done" });
    expect(await getAskMessage(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("claimAskMessage takes a pending answer once; release puts a running one back (T14)", async () => {
    const m = await addAskMessage(db, { sessionId: s.id, ownerId: OWNER, role: "assistant", text: "", status: "pending" });
    const [a, b] = await Promise.all([claimAskMessage(db, m.id), claimAskMessage(db, m.id)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect((await getAskMessage(db, m.id))!.status).toBe("running");
    await releaseAskMessage(db, m.id);
    expect((await getAskMessage(db, m.id))!.status).toBe("pending");
    expect(await claimAskMessage(db, m.id)).toBe(true);
    await finishAskMessage(db, m.id, { text: "Done", status: "done" });
    await releaseAskMessage(db, m.id);
    expect((await getAskMessage(db, m.id))!.status).toBe("done");
    expect(await claimAskMessage(db, m.id)).toBe(false);
  });

  it("problem reports are listed per owner", async () => {
    await addProblemReport(db, { ownerId: OWNER, sessionId: s.id, targetKind: "quote", targetId: "q", note: "wrong" });
    expect((await listProblemReports(db, OWNER)).map((r) => r.note)).toEqual(["wrong"]);
    expect(await listProblemReports(db, "x")).toEqual([]);
  });
});

describe("Task 16 helpers", () => {
  it("getClipAny returns a soft-deleted clip that getClip hides", async () => {
    const c = await newClip();
    await deleteClip(db, c.id, "user");
    expect(await getClip(db, c.id)).toBeNull();
    expect((await getClipAny(db, c.id))?.deletedAt).not.toBeNull();
  });
  it("requestTrackBurn toggles only none <-> stale/failed; deleteTrack only removes a preparing track", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    expect((await requestTrackBurn(db, t.id, true))?.burnStatus).toBe("stale");
    await setTrackBurnStatus(db, t.id, "queued");
    expect((await requestTrackBurn(db, t.id, false))?.burnStatus).toBe("queued");
    await setTrackBurnStatus(db, t.id, "failed");
    expect((await requestTrackBurn(db, t.id, false))?.burnStatus).toBe("none");
    await setTrackCues(db, t.id, [cue("x")], "ready");
    await deleteTrack(db, t.id);
    expect(await getTrack(db, t.id)).not.toBeNull();
    const p = (await createTrack(db, c.id, "fr"))!;
    await deleteTrack(db, p.id);
    expect(await getTrack(db, p.id)).toBeNull();
  });
  it("deleteFailedTrack removes a failed track only", async () => {
    const c = await newClip();
    const preparing = (await createTrack(db, c.id, "de"))!;
    expect(await deleteFailedTrack(db, preparing.id)).toBe(false);
    const ready = (await createTrack(db, c.id, "es"))!;
    await setTrackCues(db, ready.id, [cue("x")], "ready");
    expect(await deleteFailedTrack(db, ready.id)).toBe(false);
    expect(await getTrack(db, preparing.id)).not.toBeNull();
    expect(await getTrack(db, ready.id)).not.toBeNull();
    await failTrack(db, preparing.id, "ANTHROPIC_API_KEY is not set on the server.");
    expect(await deleteFailedTrack(db, preparing.id)).toBe(true);
    expect(await getTrack(db, preparing.id)).toBeNull();
    expect(await deleteFailedTrack(db, preparing.id)).toBe(false);
  });
});
