import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { ProposedClip } from "../schemas.ts";
import { createDb, type Db } from "./client.ts";
import {
  claimClipRender, createSession, deleteSession, finishClipRender, getClip, getContextCard, getSession, getTranscript, listClips,
  listExpiredSessions, replaceAiClips, saveContextCard, saveTranscript, setClipBounds, setClipStatus,
  setClipThumb, setRenderState, setStage, transitionStage, updateSession, type Session,
} from "./repo.ts";
import { clipEvents } from "./schema.ts";

const tree: ProposedClip[] = [
  {
    title: "Parent", reason: "r", label: "key_point", score: 90, startMs: 10_000, endMs: 100_000,
    children: [
      { title: "Kid A", reason: "r", label: "heated", score: 70, startMs: 20_000, endMs: 40_000 },
      { title: "Kid B", reason: "r", label: "light", score: 60, startMs: 60_000, endMs: 80_000 },
    ],
  },
];

let db: Db;
let close: () => Promise<void>;
let s: Session;

beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("TRUNCATE sessions, transcripts, context_cards, clips, clip_events RESTART IDENTITY CASCADE");
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
    await replaceAiClips(db, s.id, tree);
    await deleteSession(db, s.id);
    expect(await getSession(db, s.id)).toBeNull();
    expect(await listClips(db, s.id)).toHaveLength(0);
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
    expect(await transitionStage(db, s.id, "awaiting_context", "finding_clips", 70)).toBe(false);
    expect((await getSession(db, s.id))?.stage).toBe("understanding");
  });
});

describe("clips", () => {
  it("replaceAiClips is idempotent", async () => {
    await replaceAiClips(db, s.id, tree);
    await replaceAiClips(db, s.id, tree);
    const clips = await listClips(db, s.id);
    expect(clips.length).toBe(3);
    expect(clips.map((c) => c.title)).toEqual(["Parent", "Kid A", "Kid B"]);
    expect(await db.select().from(clipEvents)).toHaveLength(3); // events of replaced clips cascade away
  });

  it("replaceAiClips keeps clips the user already approved", async () => {
    const [parent, kidA] = await replaceAiClips(db, s.id, tree);
    await setClipStatus(db, kidA!.id, "approved", "user");
    await replaceAiClips(db, s.id, tree);
    const clips = await listClips(db, s.id);
    expect(clips.find((c) => c.id === kidA!.id)?.status).toBe("approved");
    expect(clips.find((c) => c.id === parent!.id)).toBeUndefined();
    expect(clips).toHaveLength(4); // approved kid (orphaned) + new parent + 2 new kids
  });

  it("setClipStatus logs an event", async () => {
    const [parent] = await replaceAiClips(db, s.id, tree);
    const c = await setClipStatus(db, parent!.id, "rejected", "copilot");
    expect(c.status).toBe("rejected");
    const ev = (await db.select().from(clipEvents)).filter((e) => e.kind === "status");
    expect(ev).toEqual([expect.objectContaining({ actor: "copilot", before: { status: "proposed" }, after: { status: "rejected" } })]);
  });

  it("moving a parent flags children that fall outside", async () => {
    const [parent] = await replaceAiClips(db, s.id, tree);
    await setClipBounds(db, parent!.id, { startMs: 50_000, endMs: 90_000 }, "user");
    const kids = (await listClips(db, s.id)).filter((c) => c.parentId === parent!.id);
    expect(kids.find((k) => k.startMs < 50_000)!.outOfBounds).toBe(true);
    expect(kids.find((k) => k.startMs >= 50_000)!.outOfBounds).toBe(false);
    await setClipBounds(db, parent!.id, { startMs: 0, endMs: 200_000 }, "user");
    expect((await listClips(db, s.id)).every((c) => !c.outOfBounds)).toBe(true);
  });

  it("editing a rendered clip marks render stale", async () => {
    const [parent] = await replaceAiClips(db, s.id, tree);
    await setRenderState(db, parent!.id, { renderStatus: "done", renderKey: `${s.id}/clips/x.mp4` });
    const updated = await setClipBounds(db, parent!.id, { startMs: 11_000, endMs: 99_000 }, "user");
    expect(updated.renderStatus).toBe("stale");
    expect((await getClip(db, parent!.id))!.renderKey).toBe(`${s.id}/clips/x.mp4`);
    const events = (await db.select().from(clipEvents)).filter((e) => e.kind === "bounds");
    expect(events[0]).toMatchObject({ before: { startMs: 10_000, endMs: 100_000 }, after: { startMs: 11_000, endMs: 99_000 } });
  });

  it("re-saving the same bounds leaves a finished render done", async () => {
    const [parent] = await replaceAiClips(db, s.id, tree);
    await setRenderState(db, parent!.id, { renderStatus: "done" });
    const same = await setClipBounds(db, parent!.id, { startMs: 10_000, endMs: 100_000 }, "user");
    expect(same.renderStatus).toBe("done");
  });

  it("claimClipRender queues a clip only from none, failed or stale, once", async () => {
    const [parent, kidA, kidB] = await replaceAiClips(db, s.id, tree);
    await setRenderState(db, kidA!.id, { renderStatus: "stale" });
    await setRenderState(db, kidB!.id, { renderStatus: "rendering" });
    const claims = await Promise.all([claimClipRender(db, kidA!.id), claimClipRender(db, kidA!.id)]);
    expect(claims.sort()).toEqual([false, true]);
    expect((await getClip(db, kidA!.id))!.renderStatus).toBe("queued");
    expect(await claimClipRender(db, kidB!.id)).toBe(false);
    expect((await getClip(db, kidB!.id))!.renderStatus).toBe("rendering");
    expect(await claimClipRender(db, parent!.id)).toBe(true); // none
    await setRenderState(db, parent!.id, { renderStatus: "failed" });
    expect(await claimClipRender(db, parent!.id)).toBe(true);
    await setRenderState(db, parent!.id, { renderStatus: "done" });
    expect(await claimClipRender(db, parent!.id)).toBe(false);
  });

  it("finishClipRender marks done only if the clip is still approved with the rendered bounds", async () => {
    const [parent] = await replaceAiClips(db, s.id, tree);
    const keys = { renderKey: `${s.id}/clips/p.mp4`, srtKey: `${s.id}/clips/p.srt` };
    const rendered = { startMs: 10_000, endMs: 100_000 };
    await setClipStatus(db, parent!.id, "approved", "user");
    expect(await finishClipRender(db, parent!.id, rendered, keys)).toBe("done");
    expect(await getClip(db, parent!.id)).toMatchObject({ renderStatus: "done", ...keys });

    await setClipBounds(db, parent!.id, { startMs: 12_000, endMs: 100_000 }, "user");
    expect(await finishClipRender(db, parent!.id, rendered, keys)).toBe("stale");
    expect(await getClip(db, parent!.id)).toMatchObject({ renderStatus: "stale", ...keys });

    await setClipStatus(db, parent!.id, "neutral", "user");
    expect(await finishClipRender(db, parent!.id, { startMs: 12_000, endMs: 100_000 }, keys)).toBe("stale");
    expect(await finishClipRender(db, "00000000-0000-0000-0000-000000000000", rendered, keys)).toBeNull();
  });

  it("setClipThumb stores the thumbnail key", async () => {
    const [parent] = await replaceAiClips(db, s.id, tree);
    const updated = await setClipThumb(db, parent!.id, `${s.id}/thumbs/${parent!.id}.jpg`);
    expect(updated.thumbKey).toBe(`${s.id}/thumbs/${parent!.id}.jpg`);
    expect((await getClip(db, parent!.id))!.thumbKey).toBe(`${s.id}/thumbs/${parent!.id}.jpg`);
    await expect(setClipThumb(db, "00000000-0000-0000-0000-000000000000", "x")).rejects.toThrow("Clip not found");
  });

  it("orders parents by score desc with children by start", async () => {
    const mk = (title: string, score: number): ProposedClip => ({ ...tree[0]!, title, score, children: [tree[0]!.children[1]!, tree[0]!.children[0]!] });
    await replaceAiClips(db, s.id, [mk("Low", 10), mk("High", 95)]);
    const titles = (await listClips(db, s.id)).map((c) => c.title);
    expect(titles).toEqual(["High", "Kid A", "Kid B", "Low", "Kid A", "Kid B"]);
  });
});

describe("child bounds", () => {
  it("editing a flagged child back inside its parent clears the flag", async () => {
    const [parent, kid] = await replaceAiClips(db, s.id, tree);
    await setClipBounds(db, parent!.id, { startMs: 50_000, endMs: 90_000 }, "user");
    expect((await getClip(db, kid!.id))!.outOfBounds).toBe(true);
    const fixed = await setClipBounds(db, kid!.id, { startMs: 55_000, endMs: 70_000 }, "user");
    expect(fixed.outOfBounds).toBe(false);
  });

  it("moving a child outside its parent flags it", async () => {
    const [, kid] = await replaceAiClips(db, s.id, tree);
    const moved = await setClipBounds(db, kid!.id, { startMs: 5_000, endMs: 30_000 }, "user");
    expect(moved.outOfBounds).toBe(true);
  });
});
