import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.ts";
import { completeAnalysisVersion, saveMoments, saveTopics, startAnalysisVersion } from "./analysis.ts";
import { createSession, updateSession, type Session } from "./repo.ts";
import { sql } from "drizzle-orm";
import { clipEvents, clips, subtitleTracks } from "./schema.ts";
import {
  addAskMessage, addProblemReport, approveTrack, claimClipRender, claimTrackBurn, createAskAction, createClip,
  createPersonalMoment, burnSignature, createTrack, deleteClip, editTrackCues, finishAskMessage, finishClipRender,
  finishTrackBurn, setTrackBurnStatus, getAskMessage, getClip, getTrack, listAskMessages, listClips, listPersonalMoments, listProblemReports, listSelections,
  countSelectionsByAnalysis,
  resolveAskAction, deleteTrack, deleteFailedTrack, failTrack, getClipAny, requestTrackBurn, setSelection, setTrackCues, undoLastEvent, updateClip,
  StaleClipError, staleCardClips, setClipRenderStatus, mergeClips, listClipPreviews, confirmClips, claimMomentCheck, releaseMomentCheck, claimAskMessage, releaseAskMessage, listClipEvents, clipsMadeByAsk, applyClipUpdate, ClipTitleNotOwnError, replaceClipMoment, listTracks,
} from "./personal.ts";
import { getMoment, setMomentChecks } from "./analysis.ts";
import { moments as momentsTable } from "./schema.ts";
import type { TrackCue } from "../personalTypes.ts";
import { createCustomPerson } from "./names.ts";
import type { NewMoment } from "./analysis.ts";
import { startAskQuestion, ASK_QUEUE_FAILED, AskQueueError, listAskMessages as listAsk, listShownRanges, requestFindMore, claimFindMore, finishFindMore, failFindMore, getFindMore } from "./personal.ts";

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

  it("createPersonalMoment puts the moment in the topic holding its start, else the nearest topic", async () => {
    const [intro, late] = await saveTopics(db, analysisId, [
      { idx: 0, startMs: 0, endMs: 600_000, title: "Intro", summary: "s" },
      { idx: 1, startMs: 4_629_065, endMs: 4_811_330, title: "Putin", summary: "s" },
    ]);
    const inside = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 4_766_012, endMs: 4_789_042, title: "Late", origin: "ask" });
    expect(inside.topicId).toBe(late!.id);
    const gap = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 700_000, endMs: 720_000, title: "Gap", origin: "user" });
    expect(gap.topicId).toBe(intro!.id);
    const after = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 5_900_000, endMs: 5_920_000, title: "After", origin: "user" });
    expect(after.topicId).toBe(late!.id);
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
    await setSelection(db, OWNER, b1!.id, "rejected");
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
  it("clipsMadeByAsk is the clips whose creation was by Ask", async () => {
    const byUser = await newClip();
    const byAsk = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 60_000, endMs: 90_000, actor: "ask" });
    // a later edit by Ask does not make a user's clip an Ask clip
    await updateClip(db, byUser.id, { startMs: 12_000 }, "ask");
    expect([...(await clipsMadeByAsk(db, [byUser.id, byAsk.id]))]).toEqual([byAsk.id]);
    expect((await clipsMadeByAsk(db, [])).size).toBe(0);
  });

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

  it("undoing the creation of an Ask clip clears its moment's approval; user and official moments keep theirs", async () => {
    const mk = async (origin: "ask" | "user") => {
      const m = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 0, endMs: 20_000, title: origin, origin });
      await setSelection(db, OWNER, m.id, "approved");
      const c = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m.id, startMs: 0, endMs: 20_000, actor: "user" });
      return { m, c };
    };
    const ask = await mk("ask");
    const user = await mk("user");
    await undoLastEvent(db, ask.c.id);
    await undoLastEvent(db, user.c.id);
    const sel = await listSelections(db, OWNER, s.id);
    expect(sel[ask.m.id]).toBeUndefined();
    expect(sel[user.m.id]).toBe("approved");
  });

  it("undoing an Ask clip's creation keeps a choice the user changed since, and an official moment's selection", async () => {
    const m = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 0, endMs: 20_000, title: "ask", origin: "ask" });
    await setSelection(db, OWNER, m.id, "approved");
    const c = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m.id, startMs: 0, endMs: 20_000, actor: "ask" });
    await setSelection(db, OWNER, m.id, "rejected");
    await undoLastEvent(db, c.id);
    expect((await listSelections(db, OWNER, s.id))[m.id]).toBe("rejected");

    const [off] = await saveMoments(db, analysisId, [
      { topicId: null, granularity: "passage", startMs: 0, endMs: 40_000, title: "O", why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai", highlights: [] },
    ]);
    await setSelection(db, OWNER, off!.id, "approved");
    const oc = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: off!.id, startMs: 0, endMs: 20_000, actor: "user" });
    await undoLastEvent(db, oc.id);
    expect((await listSelections(db, OWNER, s.id))[off!.id]).toBe("approved");
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
    const geo = { startMs: 10_000, endMs: 50_000, format: "16:9" as const, cropOffset: 0, credit: null, subtitleStyle: "yellow" as const, subtitlePosition: "bottom" as const };
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
    const geo = { startMs: 10_000, endMs: 50_000, format: "16:9" as const, cropOffset: 0, credit: null, subtitleStyle: "yellow" as const, subtitlePosition: "bottom" as const };
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
    // The trim outdated the track (its cues were built for the old range): it can't be burned again until rebuilt,
    // and a burn that took the new bounds' signature from it is stale too.
    expect(await getTrack(db, t.id)).toMatchObject({ status: "outdated", approvedAt: null });
    await setTrackBurnStatus(db, t.id, "none");
    expect(await claimTrackBurn(db, t.id)).toBe(false);
    const now = (await getClip(db, c.id))!;
    expect(await finishTrackBurn(db, t.id, burnSignature({ cues: [cue("Oi")] }, now), "b.mp4")).toBe("stale");
  });

  it("new clips get the position of the session's profile and the owner's latest style", async () => {
    expect(await newClip()).toMatchObject({ subtitleStyle: "yellow", subtitlePosition: "bottom" });
    await db.execute(sql`update sessions set profile = 'parliament' where id = ${s.id}`);
    const c1 = await newClip();
    expect(c1).toMatchObject({ subtitleStyle: "yellow", subtitlePosition: "above_banner" });
    await updateClip(db, c1.id, { subtitleStyle: "white_box" }, "user");
    expect(await newClip()).toMatchObject({ subtitleStyle: "white_box", subtitlePosition: "above_banner" });
  });

  it("the inherited style follows the clip whose style was set last, not the last render write", async () => {
    const a = await newClip();
    await updateClip(db, a.id, { subtitleStyle: "white_box" }, "user");
    const b = await newClip();
    await updateClip(db, b.id, { subtitleStyle: "white" }, "user");
    await setClipRenderStatus(db, a.id, "rendering");
    expect(await newClip()).toMatchObject({ subtitleStyle: "white" });
  });

  it("a style change stales a done burn, keeps the render, and undo restores it", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await db.execute(sql`update clips set render_status = 'done' where id = ${c.id}`);
    await db.execute(sqlBurnDone(t.id));
    await updateClip(db, c.id, { subtitlePosition: "top" }, "user");
    expect((await getClip(db, c.id))).toMatchObject({ renderStatus: "done", subtitlePosition: "top" });
    expect((await getTrack(db, t.id))!.burnStatus).toBe("stale");
    const events = await listClipEvents(db, c.id);
    expect(events.at(-1)).toMatchObject({ kind: "style", before: { subtitleStyle: "yellow", subtitlePosition: "bottom" }, after: { subtitleStyle: "yellow", subtitlePosition: "top" } });
    await db.execute(sqlBurnDone(t.id));
    expect(await undoLastEvent(db, c.id)).toMatchObject({ subtitlePosition: "bottom", renderStatus: "done" });
    expect((await getTrack(db, t.id))!.burnStatus).toBe("stale");
  });

  it("finishTrackBurn is stale when the style changed during the burn", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready");
    await approveTrack(db, t.id);
    await claimTrackBurn(db, t.id);
    const sig = burnSignature({ cues: [cue("Oi")] }, c);
    await updateClip(db, c.id, { subtitleStyle: "white" }, "user");
    expect(await finishTrackBurn(db, t.id, sig, "b.mp4")).toBe("stale");
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

  it("a prepare finishing while a trim is still in its transaction waits for it and ends up outdated", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    let finishing: Promise<unknown> | null = null;
    await db.transaction(async (tx) => {
      await tx.select().from(clips).where(eq(clips.id, c.id)).for("update"); // what updateClip holds
      await tx.update(clips).set({ startMs: 12_000 }).where(eq(clips.id, c.id));
      finishing = setTrackCues(db, t.id, [cue("Oi")], "ready", built);
      await new Promise((r) => setTimeout(r, 150)); // the prepare runs while the trim is uncommitted
    });
    await finishing;
    expect((await getTrack(db, t.id))!.status).toBe("outdated");
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

  it("an outdated track can't be approved or burned", async () => {
    const c = await newClip();
    const t = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, t.id, [cue("Oi")], "ready", built);
    await updateClip(db, c.id, { startMs: 12_000 }, "user");
    expect(await approveTrack(db, t.id)).toBe("not_ready");
    await db.execute(sql`update ${subtitleTracks} set approved_at = now(), burn_status = 'stale' where id = ${t.id}`); // a racing approve
    expect(await claimTrackBurn(db, t.id)).toBe(false);
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

  it("reopenToolApproval reopens only a resolved card whose answer still waits", async () => {
    const { createToolApproval, resolveToolApproval, reopenToolApproval, getAskAction } = await import("./personal.ts");
    const card = async () => {
      const m = await addAskMessage(db, { sessionId: s.id, ownerId: OWNER, role: "assistant", text: "", status: "running" });
      const a = await createToolApproval(db, m.id, { step: 1, calls: [{ id: "c1", name: "propose_clip", args: {}, summary: "Make a clip" }] });
      return { m, a };
    };
    const ok = await card();
    expect(await resolveToolApproval(db, ok.a.id, { decision: "approve" })).toBe(true);
    await reopenToolApproval(db, ok.a.id); // the resume job couldn't be sent
    expect(await getAskAction(db, ok.a.id)).toMatchObject({ status: "pending", resolution: null });

    // The send threw after the job was stored: the resume ran and the answer finished. The card stays resolved.
    const ran = await card();
    expect(await resolveToolApproval(db, ran.a.id, { decision: "reject" })).toBe(true);
    await finishAskMessage(db, ran.m.id, { text: "Done", status: "done" });
    await reopenToolApproval(db, ran.a.id);
    expect(await getAskAction(db, ran.a.id)).toMatchObject({ status: "dismissed", resolution: { decision: "reject" } });

    // A bulk action is never touched.
    const bulk = await createAskAction(db, { messageId: ok.m.id, kind: "bulk_selection", payload: { ids: [] } });
    expect(await resolveAskAction(db, bulk.id, "confirmed")).toBe(true);
    await reopenToolApproval(db, bulk.id);
    expect((await getAskAction(db, bulk.id))?.status).toBe("confirmed");
  });

  it("the bulk-selection resolvers never resolve a tool approval card (it would wait for ever without its resume)", async () => {
    const { createToolApproval, confirmBulkSelection, getAskAction } = await import("./personal.ts");
    const m = await addAskMessage(db, { sessionId: s.id, ownerId: OWNER, role: "assistant", text: "", status: "running" });
    const a = await createToolApproval(db, m.id, { step: 1, calls: [{ id: "c1", name: "propose_clip", args: {}, summary: "Make a clip" }] });
    expect(await resolveAskAction(db, a.id, "dismissed")).toBe(false);
    expect(await confirmBulkSelection(db, OWNER, a.id, [], "approved")).toBe(false);
    expect((await getAskAction(db, a.id))?.status).toBe("pending");
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

describe("find more", () => {
  const found = (title: string, startMs = 0): NewMoment => ({
    topicId: null, granularity: "passage", startMs, endMs: startMs + 40_000, title, why: "w", relevance: 80, speakers: ["A"], evidence: [],
    origin: "find_more", highlights: [{ type: "heated", method: "ai", value: null }],
  });
  const run = async (personId: string, rows: NewMoment[]) => {
    const r = (await requestFindMore(db, { ownerId: OWNER, analysisId, personId }))!;
    expect(await claimFindMore(db, r.id)).toBe(true);
    return { id: r.id, count: await finishFindMore(db, r.id, rows) };
  };

  it("requestFindMore returns null while one is pending or running (re-request after done resets it to pending)", async () => {
    const p = await createCustomPerson(db, { displayName: "Tralli", createdBy: "t" });
    const a = { ownerId: OWNER, analysisId, personId: p.id };
    const first = (await requestFindMore(db, a))!;
    expect(first.status).toBe("pending");
    expect(await requestFindMore(db, a)).toBeNull();
    expect(await claimFindMore(db, first.id)).toBe(true);
    expect(await claimFindMore(db, first.id)).toBe(false);
    expect(await requestFindMore(db, a)).toBeNull();
    expect(await finishFindMore(db, first.id, [found("x")])).toBe(1);
    expect((await getFindMore(db, a))).toMatchObject({ status: "done", momentCount: 1 });
    const again = (await requestFindMore(db, a))!;
    expect(again).toMatchObject({ id: first.id, status: "pending", error: null });
    await failFindMore(db, again.id, "nope");
    expect(await getFindMore(db, a)).toMatchObject({ status: "failed", error: "nope" });
    expect((await requestFindMore(db, a))?.status).toBe("pending");
  });

  it("finishFindMore replaces this person's earlier find-more moments only, keeping the ones with a selection", async () => {
    const tralli = await createCustomPerson(db, { displayName: "Tralli", createdBy: "t" });
    const other = await createCustomPerson(db, { displayName: "Other", createdBy: "t" });
    const mine = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 0, endMs: 20_000, title: "Asked", origin: "ask" });
    await run(other.id, [found("Other's", 100_000)]);
    const first = await run(tralli.id, [found("Old 1", 200_000), found("Old 2", 300_000)]);
    expect((await listPersonalMoments(db, OWNER, analysisId)).filter((m) => m.origin === "find_more")).toHaveLength(3);

    const [old] = (await listPersonalMoments(db, OWNER, analysisId)).filter((m) => m.title === "Old 1");
    await setSelection(db, OWNER, old!.id, "rejected"); // any status keeps it
    const req = (await requestFindMore(db, { ownerId: OWNER, analysisId, personId: tralli.id }))!;
    expect(req.id).toBe(first.id);
    await claimFindMore(db, req.id);
    expect(req.momentCount).toBe(0); // the reset zeroes the count
    // the kept moment still counts as shown; the unselected one doesn't
    expect(await listShownRanges(db, { analysisId, ownerId: OWNER, requestId: req.id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ startMs: 200_000 })]),
    );
    expect((await listShownRanges(db, { analysisId, ownerId: OWNER, requestId: req.id })).some((r) => r.startMs === 300_000)).toBe(false);
    expect(await finishFindMore(db, req.id, [found("New", 400_000)])).toBe(1);

    const all = await listPersonalMoments(db, OWNER, analysisId);
    expect(all.map((m) => m.title).sort()).toEqual(["Asked", "New", "Old 1", "Other's"]);
    expect(all.find((m) => m.title === "New")).toMatchObject({ origin: "find_more", ownerId: OWNER, findMoreRequestId: req.id });
    expect(all.find((m) => m.title === "New")!.highlights).toEqual([{ type: "heated", method: "ai", value: null }]);
    expect(all.find((m) => m.id === mine.id)).toBeTruthy();
    expect(await listSelections(db, OWNER, s.id)).toEqual({ [old!.id]: "rejected" });
    expect(await getFindMore(db, { ownerId: OWNER, analysisId, personId: tralli.id })).toMatchObject({ status: "done", momentCount: 1 });
  });

  it("finishFindMore keeps a found moment a live clip was made from, even with its selection cleared", async () => {
    const p = await createCustomPerson(db, { displayName: "Tralli", createdBy: "t" });
    const first = await run(p.id, [found("Clipped", 200_000), found("Plain", 300_000)]);
    const clipped = (await listPersonalMoments(db, OWNER, analysisId)).find((m) => m.title === "Clipped")!;
    await setSelection(db, OWNER, clipped.id, "approved");
    const clip = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: clipped.id, startMs: 200_000, endMs: 240_000, actor: "user" });
    await setSelection(db, OWNER, clipped.id, null); // back to proposed: the clip stays
    const req = (await requestFindMore(db, { ownerId: OWNER, analysisId, personId: p.id }))!;
    expect(req.id).toBe(first.id);
    await claimFindMore(db, req.id);
    expect(await finishFindMore(db, req.id, [found("New", 400_000)])).toBe(1);
    expect((await listPersonalMoments(db, OWNER, analysisId)).map((m) => m.title).sort()).toEqual(["Clipped", "New"]);
    expect((await getClip(db, clip.id))?.momentId).toBe(clipped.id);
  });

  it("finishFindMore stores nothing for a request that isn't running", async () => {
    const p = await createCustomPerson(db, { displayName: "Tralli", createdBy: "t" });
    const r = (await requestFindMore(db, { ownerId: OWNER, analysisId, personId: p.id }))!;
    expect(await finishFindMore(db, r.id, [found("x")])).toBe(0);
    expect(await listPersonalMoments(db, OWNER, analysisId)).toEqual([]);
  });
});

describe("merging clips", () => {
  const mrow = (title: string, startMs: number, endMs: number): NewMoment => ({
    topicId: null, granularity: "passage", startMs, endMs, title, why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai", highlights: [],
  });
  const mk = async (title: string, startMs: number, endMs: number, withMoment = true) => {
    const [m] = withMoment ? await saveMoments(db, analysisId, [mrow(title, startMs, endMs)]) : [undefined];
    const c = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m?.id ?? null, startMs, endMs, actor: "user" });
    return { c, m: m?.id as string };
  };
  const toWanted = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });

  describe("mergeClips", () => {
    it("keeps the earlier clip, spans both, soft-deletes the later, remembers its moment", async () => {
      const { c: a, m: mA } = await mk("A", 10_000, 30_000);
      const { c: b, m: mB } = await mk("B", 25_000, 40_000);
      await updateClip(db, a.id, { warningsAck: true }, "user");
      expect((await getClip(db, a.id))!.warningsAck).toBe(true);
      const r = await mergeClips(db, OWNER, [b.id, a.id], "user");
      expect(r).toMatchObject({ ok: true, absorbedId: b.id });
      expect(r.ok && r.clip).toMatchObject({ id: a.id, startMs: 10_000, endMs: 40_000, momentId: mA, mergedMomentIds: [mB], warningsAck: false });
      expect(await getClip(db, b.id)).toBeNull();
      expect((await listClipEvents(db, a.id)).at(-1)).toMatchObject({ kind: "merge", actor: "user" });
      expect((await listClipEvents(db, b.id)).map((e) => e.kind)).toEqual(["create"]);
    });

    it("allows touching clips (A.end === B.start) and refuses a 1 ms gap", async () => {
      const { c: a } = await mk("A", 10_000, 20_000);
      const { c: b } = await mk("B", 20_000, 30_000);
      const { c: d } = await mk("D", 30_001, 40_000);
      expect(await mergeClips(db, OWNER, [a.id, b.id], "user")).toMatchObject({ ok: true });
      expect(await mergeClips(db, OWNER, [a.id, d.id], "user")).toEqual({ ok: false, reason: "not_touching" });
    });

    it("refuses a clip inside the other (later one inside, same end, same start) and leaves both untouched", async () => {
      const { c: a } = await mk("A", 10_000, 40_000);
      const { c: b } = await mk("B", 20_000, 30_000);
      const { c: e } = await mk("E", 25_000, 40_000);
      const { c: f } = await mk("F", 10_000, 50_000);
      expect(await mergeClips(db, OWNER, [a.id, b.id], "user")).toEqual({ ok: false, reason: "contained" });
      expect(await mergeClips(db, OWNER, [e.id, a.id], "user")).toEqual({ ok: false, reason: "contained" });
      expect(await mergeClips(db, OWNER, [f.id, a.id], "user")).toEqual({ ok: false, reason: "contained" });
      expect(await getClip(db, a.id)).toMatchObject({ startMs: 10_000, endMs: 40_000, mergedMomentIds: [] });
      expect(await getClip(db, b.id)).toMatchObject({ startMs: 20_000, endMs: 30_000 });
      expect((await listClipEvents(db, a.id)).map((ev) => ev.kind)).toEqual(["create"]);
    });

    it("same start, one confirmClips call (equal createdAt): listed by id, and never merged (one is inside the other)", async () => {
      const ms = await saveMoments(db, analysisId, [mrow("P", 10_000, 20_000), mrow("Q", 10_000, 30_000), mrow("R", 10_000, 25_000)]);
      const made = await confirmClips(db, OWNER, s.id, ms.map((m) => ({ id: m.id, startMs: m.startMs, endMs: m.endMs })));
      const listed = (await listClips(db, OWNER, s.id)).filter((c) => made.some((m) => m.id === c.id));
      expect(listed.map((c) => c.id)).toEqual([...made.map((c) => c.id)].sort());
      expect(await mergeClips(db, OWNER, [listed[1]!.id, listed[0]!.id], "user")).toEqual({ ok: false, reason: "contained" });
    });

    it("returns not_found for a deleted clip, another owner's or another session's clip, and on a second merge of the same pair", async () => {
      const { c: a } = await mk("A", 10_000, 30_000);
      const { c: b } = await mk("B", 20_000, 40_000);
      const { c: gone } = await mk("G", 20_000, 40_000);
      await deleteClip(db, gone.id, "user");
      expect(await mergeClips(db, OWNER, [a.id, gone.id], "user")).toEqual({ ok: false, reason: "not_found" });
      expect(await mergeClips(db, "someone-else", [a.id, b.id], "user")).toEqual({ ok: false, reason: "not_found" });
      const s2 = await createSession(db, { title: "T2", source: "upload" });
      const other = await createClip(db, { sessionId: s2.id, ownerId: OWNER, startMs: 20_000, endMs: 40_000, actor: "user" });
      expect(await mergeClips(db, OWNER, [a.id, other.id], "user")).toEqual({ ok: false, reason: "not_found" });
      expect(await mergeClips(db, OWNER, [a.id, b.id], "user")).toMatchObject({ ok: true });
      expect(await mergeClips(db, OWNER, [a.id, b.id], "user")).toEqual({ ok: false, reason: "not_found" });
    });

    it("merging a merged clip again carries the absorbed moments along, without duplicates", async () => {
      const { c: a } = await mk("A", 10_000, 30_000);
      const { c: b, m: mB } = await mk("B", 25_000, 40_000);
      const { c: c3, m: mC } = await mk("C", 38_000, 50_000);
      await mergeClips(db, OWNER, [a.id, b.id], "user");
      const r = await mergeClips(db, OWNER, [a.id, c3.id], "user");
      expect(r.ok && r.clip.mergedMomentIds).toEqual([mB, mC]);
      // absorbing a clip that itself holds merged moments carries them too, and never lists the survivor's own moment
      const { c: x, m: mX } = await mk("X", 60_000, 70_000);
      const { c: y, m: mY } = await mk("Y", 65_000, 80_000);
      await mergeClips(db, OWNER, [x.id, y.id], "user");
      const { c: z } = await mk("Z", 5_000, 62_000, false);
      const r2 = await mergeClips(db, OWNER, [z.id, x.id], "user");
      expect(r2.ok && r2.clip.mergedMomentIds).toEqual([mX, mY]);
    });

    it("outdates the survivor's tracks and stales its done render", async () => {
      const { c: a } = await mk("A", 10_000, 30_000);
      const { c: b } = await mk("B", 25_000, 40_000);
      const t = (await createTrack(db, a.id, "pt"))!;
      await setTrackCues(db, t.id, [cue("Oi")], "ready", { startMs: 10_000, endMs: 30_000 });
      await setClipRenderStatus(db, a.id, "done");
      await mergeClips(db, OWNER, [a.id, b.id], "user");
      expect((await getTrack(db, t.id))!.status).toBe("outdated");
      expect((await getClip(db, a.id))!.renderStatus).toBe("stale");
    });
  });

  describe("undo of a merge", () => {
    it("restores both clips exactly as they were", async () => {
      const { c: a } = await mk("A", 10_000, 30_000);
      const { c: b } = await mk("B", 25_000, 40_000);
      const ta = (await createTrack(db, a.id, "pt"))!;
      await setTrackCues(db, ta.id, [cue("Oi")], "ready", { startMs: 10_000, endMs: 30_000 });
      const tb = (await createTrack(db, b.id, "en"))!;
      await setTrackCues(db, tb.id, [cue("Hi")], "ready", { startMs: 25_000, endMs: 40_000 });
      await mergeClips(db, OWNER, [a.id, b.id], "user");
      expect((await getTrack(db, ta.id))!.status).toBe("outdated");
      await undoLastEvent(db, a.id);
      expect(await getClip(db, a.id)).toMatchObject({ startMs: 10_000, endMs: 30_000, mergedMomentIds: [] });
      expect(await getClip(db, b.id)).toMatchObject({ startMs: 25_000, endMs: 40_000, deletedAt: null });
      expect(await getTrack(db, ta.id)).toMatchObject({ status: "ready", approvedAt: null });
      expect(await getTrack(db, tb.id)).toMatchObject({ status: "ready" });
      expect((await listClipEvents(db, a.id)).at(-1)).toMatchObject({ kind: "merge", undoneAt: expect.any(Date) });
    });

    it("merge, trim, undo, undo: the trim goes first, then the merge", async () => {
      const { c: a } = await mk("A", 10_000, 30_000);
      const { c: b } = await mk("B", 25_000, 40_000);
      await mergeClips(db, OWNER, [a.id, b.id], "user");
      await updateClip(db, a.id, { endMs: 35_000 }, "user");
      await undoLastEvent(db, a.id);
      expect(await getClip(db, a.id)).toMatchObject({ startMs: 10_000, endMs: 40_000, mergedMomentIds: [expect.any(String)] });
      await undoLastEvent(db, a.id);
      expect(await getClip(db, a.id)).toMatchObject({ startMs: 10_000, endMs: 30_000, mergedMomentIds: [] });
      expect(await getClip(db, b.id)).not.toBeNull();
    });
  });

  describe("undo of an absorbed clip", () => {
    it("does nothing on its own (create or bounds event), and the merge undo still restores it intact", async () => {
      const { c: a } = await mk("A", 10_000, 30_000);
      const { c: b } = await mk("B", 25_000, 40_000);
      await updateClip(db, b.id, { endMs: 45_000 }, "ask");
      await mergeClips(db, OWNER, [a.id, b.id], "user");
      expect(await undoLastEvent(db, b.id)).toBeNull();
      expect((await getClipAny(db, b.id))).toMatchObject({ endMs: 45_000 });
      expect((await listClipEvents(db, b.id)).every((e) => e.undoneAt === null)).toBe(true);
      await undoLastEvent(db, a.id);
      expect(await getClip(db, b.id)).toMatchObject({ startMs: 25_000, endMs: 45_000, deletedAt: null });
    });
  });

  describe("confirmClips after a merge", () => {
    it("does not recreate the absorbed moment's clip and returns the merged clip once", async () => {
      const { c: a, m: mA } = await mk("A", 10_000, 30_000);
      const { c: b, m: mB } = await mk("B", 25_000, 40_000);
      await mergeClips(db, OWNER, [a.id, b.id], "user");
      const out = await confirmClips(db, OWNER, s.id, [toWanted(mA, 10_000, 30_000), toWanted(mB, 25_000, 40_000)]);
      expect(out.map((c) => c.id)).toEqual([a.id]);
      expect((await listClips(db, OWNER, s.id)).map((c) => c.id)).toEqual([a.id]);
    });
  });
});

describe("confirmClips remembered credit", () => {
  const wanted = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });
  const mom = async (title: string, startMs: number, endMs: number) =>
    (await saveMoments(db, analysisId, [{
      topicId: null, granularity: "passage", startMs, endMs, title, why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai", highlights: [],
    }]))[0]!.id;

  it("gives a new clip the credit most recently typed on the session's clips", async () => {
    const a = await mom("A", 1_000, 9_000);
    const [first] = await confirmClips(db, OWNER, s.id, [wanted(a, 1_000, 9_000)]);
    expect(first!.credit).toBeNull();
    await updateClip(db, first!.id, { credit: "City Radio" }, "user");
    const b = await mom("B", 20_000, 29_000);
    const out = await confirmClips(db, OWNER, s.id, [wanted(a, 1_000, 9_000), wanted(b, 20_000, 29_000)]);
    expect(out.find((c) => c.id !== first!.id)).toMatchObject({ credit: "City Radio", noCreditNeeded: false });
    expect(out.find((c) => c.id === first!.id)!.credit).toBe("City Radio");
  });

  it("is the credit typed last, not the clip a render touched last", async () => {
    const a = await mom("A", 1_000, 9_000);
    const b = await mom("B", 20_000, 29_000);
    const [c1, c2] = await confirmClips(db, OWNER, s.id, [wanted(a, 1_000, 9_000), wanted(b, 20_000, 29_000)]);
    await updateClip(db, c1!.id, { credit: "Old" }, "user");
    await updateClip(db, c2!.id, { credit: "Typed last" }, "user");
    await db.update(clips).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(clips.id, c1!.id)); // a render write
    const c = await mom("C", 40_000, 49_000);
    const out = await confirmClips(db, OWNER, s.id, [wanted(c, 40_000, 49_000)]);
    expect(out[0]!.credit).toBe("Typed last");
  });

  it("reaches clips made one by one too (Ask propose_clip uses createClip)", async () => {
    const [c1] = await confirmClips(db, OWNER, s.id, [wanted(await mom("A", 1_000, 9_000), 1_000, 9_000)]);
    await updateClip(db, c1!.id, { credit: "City Radio" }, "user");
    const made = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 30_000, endMs: 40_000, actor: "ask" });
    expect(made.credit).toBe("City Radio");
  });

  it("a credit cleared last means no default", async () => {
    const [c1] = await confirmClips(db, OWNER, s.id, [wanted(await mom("A", 1_000, 9_000), 1_000, 9_000)]);
    await updateClip(db, c1!.id, { credit: "City Radio" }, "user");
    await updateClip(db, c1!.id, { credit: null }, "user");
    const made = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 30_000, endMs: 40_000, actor: "user" });
    expect(made.credit).toBeNull();
  });

  it("ignores other sessions and clips without a credit", async () => {
    const s2 = await createSession(db, { title: "Other", source: "upload" });
    const o = await createClip(db, { sessionId: s2.id, ownerId: OWNER, startMs: 0, endMs: 5_000, actor: "user" });
    await updateClip(db, o.id, { credit: "Elsewhere" }, "user");
    const a = await mom("A", 1_000, 9_000);
    const [c] = await confirmClips(db, OWNER, s.id, [wanted(a, 1_000, 9_000)]);
    expect(c!.credit).toBeNull();
  });
});

describe("listClipPreviews", () => {
  it("returns live clips per session in Prepare order with thumb, tracks and merged flag", async () => {
    const [m] = await saveMoments(db, analysisId, [{
      topicId: null, granularity: "passage", startMs: 10_000, endMs: 20_000, title: "M", why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai", highlights: [],
    }]);
    await db.update(momentsTable).set({ thumbKey: `${s.id}/thumbs/${m!.id}.jpg` }).where(eq(momentsTable.id, m!.id));
    const late = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: null, startMs: 30_000, endMs: 40_000, actor: "user" });
    const early = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m!.id, startMs: 10_000, endMs: 20_000, actor: "user" });
    const gone = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 5_000, endMs: 6_000, actor: "user" });
    await deleteClip(db, gone.id, "user");
    await createClip(db, { sessionId: s.id, ownerId: "someone-else", startMs: 1_000, endMs: 2_000, actor: "user" });
    await createTrack(db, early.id, "en");
    await createTrack(db, early.id, "de");
    await setClipRenderStatus(db, late.id, "done");
    await db.update(clips).set({ mergedMomentIds: [m!.id] }).where(eq(clips.id, late.id));
    const s2 = await createSession(db, { title: "T2", source: "upload" });
    const other = await createClip(db, { sessionId: s2.id, ownerId: OWNER, startMs: 0, endMs: 9_000, actor: "user" });

    const out = await listClipPreviews(db, OWNER, [s.id, s2.id]);
    expect(out.filter((c) => c.sessionId === s.id).map((c) => c.id)).toEqual([early.id, late.id]);
    expect(out.find((c) => c.id === early.id)).toEqual({
      id: early.id, sessionId: s.id, startMs: 10_000, endMs: 20_000, format: "16:9", merged: false, rendered: false,
      thumbKey: `${s.id}/thumbs/${m!.id}.jpg`, momentId: m!.id, languages: ["de", "en"], audio: false,
    });
    expect(out.find((c) => c.id === late.id)).toMatchObject({ merged: true, rendered: true, thumbKey: null, momentId: null, languages: [] });
    expect(out.find((c) => c.id === other.id)).toMatchObject({ sessionId: s2.id, audio: false });
    await updateSession(db, s2.id, { hasVideo: false });
    expect((await listClipPreviews(db, OWNER, [s2.id]))[0]).toMatchObject({ id: other.id, audio: true });
    expect(out).toHaveLength(3);
  });

  it("returns [] for no session ids", async () => {
    await newClip();
    expect(await listClipPreviews(db, OWNER, [])).toEqual([]);
  });
});

describe("edit version", () => {
  const version = async (id: string) => (await getClip(db, id))!.editVersion;

  it("bounds, format, crop, credit and no-credit changes bump the edit version once each", async () => {
    const c = await newClip();
    expect(c.editVersion).toBe(0);
    await updateClip(db, c.id, { startMs: 11_000, endMs: 49_000 }, "user");
    expect(await version(c.id)).toBe(1);
    await updateClip(db, c.id, { format: "9:16" }, "user");
    expect(await version(c.id)).toBe(2);
    await updateClip(db, c.id, { cropOffset: 0.5 }, "user");
    expect(await version(c.id)).toBe(3);
    await updateClip(db, c.id, { credit: "Agência" }, "user");
    expect(await version(c.id)).toBe(4);
    await updateClip(db, c.id, { noCreditNeeded: true }, "user");
    expect(await version(c.id)).toBe(5);
  });

  it("renders, acknowledgements, subtitle style and cue edits don't bump it", async () => {
    const c = await newClip();
    const t = await createTrack(db, c.id, "en");
    await setTrackCues(db, t!.id, [cue("Hi")], "ready");
    const before = await version(c.id);
    await updateClip(db, c.id, { warningsAck: true }, "user");
    await updateClip(db, c.id, { protectedAck: true }, "user");
    await updateClip(db, c.id, { subtitleStyle: "white" }, "user");
    await claimClipRender(db, c.id);
    await finishClipRender(db, c.id, { startMs: 10_000, endMs: 50_000, format: "16:9", cropOffset: 0, credit: null }, { renderKey: "k" });
    await editTrackCues(db, t!.id, [{ i: 0, text: "Edited" }]);
    expect(await version(c.id)).toBe(before);
  });

  it("merge bumps the survivor; undo of bounds or format bumps again", async () => {
    const a = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 10_000, endMs: 30_000, actor: "user" });
    const b = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 25_000, endMs: 40_000, actor: "user" });
    await mergeClips(db, OWNER, [a.id, b.id], "user");
    expect(await version(a.id)).toBe(1);
    await undoLastEvent(db, a.id);
    expect(await version(a.id)).toBe(2);
    await updateClip(db, a.id, { startMs: 11_000 }, "user");
    expect(await version(a.id)).toBe(3);
    await undoLastEvent(db, a.id);
    expect(await version(a.id)).toBe(4);
    await updateClip(db, a.id, { format: "9:16" }, "user");
    await undoLastEvent(db, a.id);
    expect(await version(a.id)).toBe(6);
  });

  it("undo of a style change doesn't bump the edit version", async () => {
    const c = await newClip();
    await updateClip(db, c.id, { subtitleStyle: "white" }, "user");
    const before = await version(c.id);
    await undoLastEvent(db, c.id);
    expect((await getClip(db, c.id))!.subtitleStyle).toBe("yellow");
    expect(await version(c.id)).toBe(before);
  });

  it("a new subtitle language bumps it, a rebuild of the same language doesn't, a rolled-back track does", async () => {
    const c = await newClip();
    const en = await createTrack(db, c.id, "en");
    expect(await version(c.id)).toBe(1);
    await failTrack(db, en!.id, "boom");
    expect(await deleteFailedTrack(db, en!.id)).toBe(true);
    await createTrack(db, c.id, "en", { rebuild: true });
    expect(await version(c.id)).toBe(1);
    const pt = await createTrack(db, c.id, "pt");
    expect(await version(c.id)).toBe(2);
    await deleteTrack(db, pt!.id);
    expect(await version(c.id)).toBe(3);
  });

  it("an updateClip patch equal to the current values doesn't bump it", async () => {
    const c = await newClip();
    await updateClip(db, c.id, { startMs: c.startMs, endMs: c.endMs, format: c.format, cropOffset: c.cropOffset, credit: c.credit, noCreditNeeded: c.noCreditNeeded }, "user");
    expect(await version(c.id)).toBe(0);
    expect((await listClipEvents(db, c.id)).map((e) => e.kind)).toEqual(["create"]);
  });

  it("updateClip with a different expectVersion throws StaleClipError and changes nothing", async () => {
    const c = await newClip();
    await expect(updateClip(db, c.id, { startMs: 12_000 }, "ask", { expectVersion: c.editVersion + 1 })).rejects.toBeInstanceOf(StaleClipError);
    expect((await getClip(db, c.id))!.startMs).toBe(c.startMs);
    const ok = await updateClip(db, c.id, { startMs: 12_000 }, "ask", { expectVersion: c.editVersion });
    expect(ok).toMatchObject({ startMs: 12_000, editVersion: 1 });
    await deleteClip(db, c.id, "user");
    await expect(updateClip(db, c.id, { startMs: 13_000 }, "ask", { expectVersion: 1 })).rejects.toBeInstanceOf(StaleClipError);
  });

  it("staleCardClips names changed and removed clips by their card number", async () => {
    const a = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 1000, endMs: 20_000, actor: "user" });
    const b = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 30_000, endMs: 60_000, actor: "user" });
    const gone = await createClip(db, { sessionId: s.id, ownerId: OWNER, startMs: 70_000, endMs: 90_000, actor: "user" });
    const card = [{ id: a.id, n: 1, version: 0 }, { id: b.id, n: 2, version: 0 }, { id: gone.id, n: 3, version: 0 }];
    await updateClip(db, b.id, { startMs: 31_000 }, "user");
    await deleteClip(db, gone.id, "user");
    expect(await staleCardClips(db, OWNER, card)).toEqual([{ n: 2, removed: false }, { n: 3, removed: true }]);
    expect(await staleCardClips(db, "someone-else", [card[0]!])).toEqual([{ n: 1, removed: true }]);
    expect(await staleCardClips(db, OWNER, [{ id: "00000000-0000-4000-8000-000000000000", n: 4, version: 0 }])).toEqual([{ n: 4, removed: true }]);
  });
});

describe("startAskQuestion", () => {
  const start = (enqueue: (id: string) => Promise<void>, over: { onlyIfEmpty?: boolean; onEnqueueError?: "rollback" | "fail" } = {}) =>
    startAskQuestion(db, enqueue, { sessionId: s.id, ownerId: OWNER, text: "3 clips", onEnqueueError: "rollback", ...over });

  it("stores the question then a pending answer and enqueues the answer", async () => {
    const calls: string[] = [];
    const r = await start(async (id) => void calls.push(id));
    expect(calls).toEqual([r!.answer.id]);
    expect(r!.question).toMatchObject({ role: "user", status: "done", text: "3 clips" });
    expect(r!.answer).toMatchObject({ role: "assistant", status: "pending" });
  });
  it("rollback: a failed enqueue removes both rows and throws AskQueueError", async () => {
    await expect(start(async () => { throw new Error("down"); })).rejects.toBeInstanceOf(AskQueueError);
    expect(await listAsk(db, OWNER, s.id)).toEqual([]);
  });
  it("fail: a failed enqueue keeps the question and fails the answer with ASK_QUEUE_FAILED", async () => {
    const r = await start(async () => { throw new Error("down"); }, { onEnqueueError: "fail" });
    const [q, a] = await listAsk(db, OWNER, s.id);
    expect(q).toMatchObject({ role: "user", status: "done" });
    expect(a).toMatchObject({ status: "failed", text: ASK_QUEUE_FAILED });
    expect(r!.answer.id).toBe(a!.id);
  });
  it("onlyIfEmpty: two calls at once store one pair", async () => {
    const [a, b] = await Promise.all([start(async () => {}, { onlyIfEmpty: true }), start(async () => {}, { onlyIfEmpty: true })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await listAsk(db, OWNER, s.id)).toHaveLength(2);
  });
});

describe("applyClipUpdate", () => {
  it("changes format (crop to centre), credit and adds a language in one event and one version", async () => {
    const c = await newClip();
    await updateClip(db, c.id, { format: "9:16", cropOffset: 0.4 }, "user");
    const v0 = (await getClip(db, c.id))!.editVersion;
    const { clip, trackId } = await applyClipUpdate(db, { clipId: c.id, ownerId: OWNER, format: "16:9", credit: "TV Globo", addLanguage: "pt", actor: "ask" });
    expect(clip).toMatchObject({ format: "16:9", cropOffset: 0, credit: "TV Globo", editVersion: v0 + 1 });
    expect(clip.creditSetAt).not.toBeNull();
    expect((await listClipEvents(db, c.id)).filter((e) => e.kind === "update")).toHaveLength(1);
    expect((await getTrack(db, trackId!))!.status).toBe("preparing");
  });

  it("renames a personal moment, refuses an analysis moment's title", async () => {
    const mine = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 10_000, endMs: 50_000, title: "Old", origin: "ask" });
    const a = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: mine.id, startMs: 10_000, endMs: 50_000, actor: "ask" });
    await applyClipUpdate(db, { clipId: a.id, ownerId: OWNER, title: "New", actor: "ask" });
    expect((await getMoment(db, mine.id))!.title).toBe("New");

    const [official] = await saveMoments(db, analysisId, [
      { topicId: null, granularity: "passage", startMs: 60_000, endMs: 100_000, title: "Official", why: "w", relevance: 50, speakers: [], evidence: [], origin: "ai", highlights: [] },
    ]);
    const b = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: official!.id, startMs: 60_000, endMs: 100_000, actor: "user" });
    const v = (await getClip(db, b.id))!.editVersion;
    await expect(applyClipUpdate(db, { clipId: b.id, ownerId: OWNER, title: "Mine", format: "9:16", actor: "ask" })).rejects.toBeInstanceOf(ClipTitleNotOwnError);
    expect((await getMoment(db, official!.id))!.title).toBe("Official");
    expect(await getClip(db, b.id)).toMatchObject({ format: "16:9", editVersion: v });
  });

  it("undo of an update restores everything it set and removes its unapproved track", async () => {
    const mine = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 10_000, endMs: 50_000, title: "Old", origin: "ask" });
    const c = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: mine.id, startMs: 10_000, endMs: 50_000, actor: "ask" });
    await updateClip(db, c.id, { cropOffset: 0.3, credit: "A" }, "user");
    const before = (await getClip(db, c.id))!;
    const { trackId } = await applyClipUpdate(db, { clipId: c.id, ownerId: OWNER, format: "9:16", credit: "B", title: "New", addLanguage: "pt", actor: "ask" });
    const undone = await undoLastEvent(db, c.id);
    expect(undone).toMatchObject({ format: before.format, cropOffset: 0.3, credit: "A" });
    expect(undone!.editVersion).toBeGreaterThan(before.editVersion + 1);
    expect((await getMoment(db, mine.id))!.title).toBe("Old");
    expect(await getTrack(db, trackId!)).toBeNull();
  });

  it("undo keeps an approved track", async () => {
    const c = await newClip();
    const { trackId } = await applyClipUpdate(db, { clipId: c.id, ownerId: OWNER, addLanguage: "pt", actor: "ask" });
    await setTrackCues(db, trackId!, [cue("Oi")], "ready");
    await approveTrack(db, trackId!);
    await undoLastEvent(db, c.id);
    expect(await getTrack(db, trackId!)).not.toBeNull();
  });

  it("expectVersion mismatch throws StaleClipError and changes nothing", async () => {
    const c = await newClip();
    await expect(applyClipUpdate(db, { clipId: c.id, ownerId: OWNER, credit: "X", actor: "ask", expectVersion: 5 })).rejects.toBeInstanceOf(StaleClipError);
    expect((await getClip(db, c.id))!.credit).toBeNull();
  });

  it("undo stales a finished render only when format, crop or credit change back", async () => {
    const mine = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 10_000, endMs: 50_000, title: "Old", origin: "ask" });
    const c = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: mine.id, startMs: 10_000, endMs: 50_000, actor: "ask" });
    const render = async () => {
      const cur = (await getClip(db, c.id))!;
      await claimClipRender(db, c.id);
      await finishClipRender(db, c.id, { startMs: cur.startMs, endMs: cur.endMs, format: cur.format, cropOffset: cur.cropOffset, credit: cur.credit }, { renderKey: "k" });
      expect((await getClip(db, c.id))!.renderStatus).toBe("done");
    };
    await render();
    await applyClipUpdate(db, { clipId: c.id, ownerId: OWNER, title: "New", addLanguage: "pt", actor: "ask" });
    expect((await getClip(db, c.id))!.renderStatus).toBe("done");
    await undoLastEvent(db, c.id);
    expect((await getClip(db, c.id))!.renderStatus).toBe("done");

    await applyClipUpdate(db, { clipId: c.id, ownerId: OWNER, credit: "X", actor: "ask" });
    await render();
    await undoLastEvent(db, c.id);
    expect((await getClip(db, c.id))!.renderStatus).toBe("stale");
  });

  it("stales a finished render", async () => {
    const c = await newClip();
    await claimClipRender(db, c.id);
    await finishClipRender(db, c.id, { startMs: 10_000, endMs: 50_000, format: "16:9", cropOffset: 0, credit: null }, { renderKey: "k" });
    await applyClipUpdate(db, { clipId: c.id, ownerId: OWNER, credit: "X", actor: "ask" });
    expect((await getClip(db, c.id))!.renderStatus).toBe("stale");
  });
});

describe("replaceClipMoment", () => {
  const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
  async function setup() {
    const old = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 10_000, endMs: 50_000, title: "Old", origin: "ask" });
    const c = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: old.id, startMs: 10_000, endMs: 50_000, format: "9:16", actor: "user" });
    await setSelection(db, OWNER, old.id, "approved");
    await updateClip(db, c.id, { cropOffset: 0.3, credit: "Agência", warningsAck: true, protectedAck: true }, "user");
    const pt = (await createTrack(db, c.id, "pt"))!;
    await setTrackCues(db, pt.id, [cue("Oi")], "ready");
    await setTrackCues(db, pt.id, [cue("Oi")], "ready", { startMs: 10_000, endMs: 50_000 });
    await approveTrack(db, pt.id);
    await createTrack(db, c.id, "de");
    return { old, c };
  }
  const swap = (clipId: string, over: Record<string, unknown> = {}) =>
    replaceClipMoment(db, { clipId, ownerId: OWNER, analysisId, startMs: 200_000, endMs: 240_000, title: "New", actor: "ask", ...over });

  it("keeps the clip's id, place, format, crop, credit and languages; new moment, bounds, reset acknowledgements", async () => {
    const { old, c } = await setup();
    const v0 = (await getClip(db, c.id))!.editVersion;
    const { clip, momentId, trackIds } = await swap(c.id);
    expect(clip).toMatchObject({ id: c.id, momentId, startMs: 200_000, endMs: 240_000, format: "9:16", cropOffset: 0.3, credit: "Agência", warningsAck: false, protectedAck: false, editVersion: v0 + 1 });
    expect((await getMoment(db, momentId))).toMatchObject({ origin: "ask", title: "New", ownerId: OWNER });
    const tracks = await listTracks(db, c.id);
    expect(tracks.map((t) => [t.language, t.status, t.approvedAt])).toEqual([["de", "preparing", null], ["pt", "preparing", null]]);
    expect(tracks.map((t) => t.id).sort()).toEqual([...trackIds].sort());
    const sel = await listSelections(db, OWNER, s.id);
    expect(sel[momentId]).toBe("approved");
    expect(sel[old.id]).toBeUndefined();
    const ev = (await listClipEvents(db, c.id)).filter((e) => e.kind === "replace");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.after).toEqual({ startMs: 200_000, endMs: 240_000, momentId });
  });

  it("stales a finished render and throws StaleClipError on a version mismatch", async () => {
    const { c } = await setup();
    await expect(swap(c.id, { expectVersion: 99 })).rejects.toBeInstanceOf(StaleClipError);
    expect((await getClip(db, c.id))!.startMs).toBe(10_000);
    await claimClipRender(db, c.id);
    const cur = (await getClip(db, c.id))!;
    await finishClipRender(db, c.id, { startMs: cur.startMs, endMs: cur.endMs, format: cur.format, cropOffset: cur.cropOffset, credit: cur.credit }, { renderKey: "k" });
    await swap(c.id, { expectVersion: cur.editVersion });
    expect((await getClip(db, c.id))!.renderStatus).toBe("stale");
  });

  it("Undo restores the old clip exactly", async () => {
    const { old, c } = await setup();
    const trackKeys = ["language", "cues", "approvedAt", "builtStartMs", "builtEndMs", "status"];
    const before = { clip: (await getClip(db, c.id))!, tracks: await listTracks(db, c.id), selections: await listSelections(db, OWNER, s.id) };
    expect(before.tracks.find((t) => t.language === "pt")!.approvedAt).not.toBeNull();
    const { momentId } = await swap(c.id);
    const undone = await undoLastEvent(db, c.id);
    expect(undone!.editVersion).toBeGreaterThan(before.clip.editVersion + 1);
    expect(await getClip(db, c.id)).toMatchObject(pick(before.clip, ["startMs", "endMs", "momentId", "warningsAck", "protectedAck", "format", "cropOffset", "credit"]));
    expect((await listTracks(db, c.id)).map((t) => pick(t, trackKeys))).toEqual(before.tracks.map((t) => pick(t, trackKeys)));
    const sel = await listSelections(db, OWNER, s.id);
    expect(sel[old.id]).toBe("approved");
    expect(sel[momentId]).toBeUndefined();
    expect(await getMoment(db, momentId)).toBeNull(); // the replacement moment goes with the undo
    expect((await listPersonalMoments(db, OWNER, analysisId)).map((m) => m.id)).not.toContain(momentId);
  });

  it("Undo keeps the replacement moment while a live clip or a selection still uses it", async () => {
    const { c } = await setup();
    const { momentId } = await swap(c.id);
    const other = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId, startMs: 200_000, endMs: 240_000, actor: "user" });
    await undoLastEvent(db, c.id);
    expect(await getMoment(db, momentId)).not.toBeNull();
    expect((await getClip(db, other.id))!.momentId).toBe(momentId);

    const { c: c2 } = await setup();
    const { momentId: m2 } = await swap(c2.id, { startMs: 300_000, endMs: 340_000 });
    await setSelection(db, OWNER, m2, "rejected");
    await undoLastEvent(db, c2.id);
    expect(await getMoment(db, m2)).not.toBeNull();
    expect((await listSelections(db, OWNER, s.id))[m2]).toBe("rejected");
  });

  it("after a replace, Prepare clips (confirmClips) doesn't bring the old moment's clip back", async () => {
    const { old, c } = await setup();
    const other = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 100_000, endMs: 130_000, title: "Other", origin: "user" });
    await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: other.id, startMs: 100_000, endMs: 130_000, actor: "user" });
    const { momentId } = await swap(c.id);
    const approved = Object.entries(await listSelections(db, OWNER, s.id)).filter(([, st]) => st === "approved").map(([id]) => id);
    expect(approved).not.toContain(old.id);
    expect(approved).toContain(momentId);
    const wanted = (await Promise.all(approved.map((id) => getMoment(db, id)))).map((m) => ({ id: m!.id, startMs: m!.startMs, endMs: m!.endMs }));
    await confirmClips(db, OWNER, s.id, wanted);
    const live = await listClips(db, OWNER, s.id);
    expect(live).toHaveLength(2);
    expect(live.find((x) => x.id === c.id)!.momentId).toBe(momentId);
  });

  it("a merge survivor replaced and then confirmed keeps the same number of clips", async () => {
    const m1 = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 10_000, endMs: 50_000, title: "A", origin: "user" });
    const m2 = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 40_000, endMs: 80_000, title: "B", origin: "user" });
    const c1 = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m1.id, startMs: 10_000, endMs: 50_000, actor: "user" });
    const c2 = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m2.id, startMs: 40_000, endMs: 80_000, actor: "user" });
    await setSelection(db, OWNER, m1.id, "approved");
    await setSelection(db, OWNER, m2.id, "approved");
    const merged = await mergeClips(db, OWNER, [c1.id, c2.id], "user");
    expect(merged.ok).toBe(true);
    expect(await listClips(db, OWNER, s.id)).toHaveLength(1);
    const { momentId } = await swap(c1.id);
    const approved = Object.entries(await listSelections(db, OWNER, s.id)).filter(([, st]) => st === "approved").map(([id]) => id);
    const wanted = (await Promise.all(approved.map((id) => getMoment(db, id)))).map((m) => ({ id: m!.id, startMs: m!.startMs, endMs: m!.endMs }));
    await confirmClips(db, OWNER, s.id, wanted);
    const live = await listClips(db, OWNER, s.id);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: c1.id, momentId });
  });

  it("replacing a merge survivor drops its merged moments and puts them back to undecided; Undo restores both exactly", async () => {
    const m1 = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 10_000, endMs: 50_000, title: "A", origin: "user" });
    const m2 = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 40_000, endMs: 80_000, title: "B", origin: "user" });
    const m3 = await createPersonalMoment(db, { analysisId, ownerId: OWNER, startMs: 70_000, endMs: 90_000, title: "C", origin: "user" });
    const c1 = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m1.id, startMs: 10_000, endMs: 50_000, actor: "user" });
    const c2 = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m2.id, startMs: 40_000, endMs: 80_000, actor: "user" });
    const c3 = await createClip(db, { sessionId: s.id, ownerId: OWNER, momentId: m3.id, startMs: 70_000, endMs: 90_000, actor: "user" });
    await setSelection(db, OWNER, m1.id, "approved");
    await setSelection(db, OWNER, m2.id, "approved");
    await mergeClips(db, OWNER, [c1.id, c2.id], "user");
    await mergeClips(db, OWNER, [c1.id, c3.id], "user"); // m3 has no selection
    const before = { clip: (await getClip(db, c1.id))!, selections: await listSelections(db, OWNER, s.id) };
    expect(before.clip.mergedMomentIds).toEqual([m2.id, m3.id]);

    const { clip, momentId } = await swap(c1.id);
    expect(clip.mergedMomentIds).toEqual([]);
    expect(await listSelections(db, OWNER, s.id)).toEqual({ [momentId]: "approved" });

    // The old moments are free again: approving one makes its own clip, the replaced clip no longer covers it.
    await setSelection(db, OWNER, m2.id, "approved");
    const made = await confirmClips(db, OWNER, s.id, [{ id: momentId, startMs: 200_000, endMs: 240_000 }, { id: m2.id, startMs: 40_000, endMs: 80_000 }]);
    expect((await listClips(db, OWNER, s.id)).map((x) => x.momentId)).toEqual([m2.id, momentId]);
    await setSelection(db, OWNER, m2.id, null);
    await deleteClip(db, made.find((x) => x.momentId === m2.id)!.id, "user");

    const undone = await undoLastEvent(db, c1.id);
    expect(undone).toMatchObject({ momentId: m1.id, mergedMomentIds: [m2.id, m3.id], startMs: before.clip.startMs, endMs: before.clip.endMs });
    expect(await listSelections(db, OWNER, s.id)).toEqual(before.selections);
  });

  it("a finished burn comes back stale on undo", async () => {
    const { c } = await setup();
    const pt = (await listTracks(db, c.id)).find((t) => t.language === "pt")!;
    await setTrackBurnStatus(db, pt.id, "done");
    await swap(c.id);
    await undoLastEvent(db, c.id);
    const back = (await listTracks(db, c.id)).find((t) => t.language === "pt")!;
    expect(back.burnStatus).toBe("stale");
  });
});
