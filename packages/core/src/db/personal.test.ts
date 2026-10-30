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
  resolveAskAction, setSelection, setTrackCues, undoLastEvent, updateClip,
} from "./personal.ts";
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

  it("problem reports are listed per owner", async () => {
    await addProblemReport(db, { ownerId: OWNER, sessionId: s.id, targetKind: "quote", targetId: "q", note: "wrong" });
    expect((await listProblemReports(db, OWNER)).map((r) => r.note)).toEqual(["wrong"]);
    expect(await listProblemReports(db, "x")).toEqual([]);
  });
});
