import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import { createSession, getClip, getSession, replaceAiClips, setClipStatus, setRenderState, setStage, type Clip } from "@digestor/core/server";
import { createHarness, type Harness } from "@/test/harness";
import { POST } from "./[id]/render/route";

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.cleanup());
afterEach(() => {
  h.send.mockClear();
  vi.restoreAllMocks();
});
/** The route logs enqueue failures; keep test output clean. */
const quietErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

type Stage = Parameters<typeof setStage>[2];
type RenderStatus = Clip["renderStatus"];

/** A session at `stage` with one clip per entry: `[status, renderStatus]`. */
async function session(stage: Stage, clips: [Clip["status"], RenderStatus][] = []) {
  const s = await createSession(h.db, { title: "t", source: "upload" });
  await setStage(h.db, s.id, stage, 70);
  const rows = await replaceAiClips(
    h.db,
    s.id,
    clips.map((_, i) => ({ title: `c${i}`, reason: "r", label: "heated", score: 90 - i, startMs: i * 10_000, endMs: i * 10_000 + 5000, children: [] })),
  );
  const ids: string[] = [];
  for (const [i, [status, renderStatus]] of clips.entries()) {
    const row = rows.find((r) => r.title === `c${i}`)!;
    if (status !== "proposed") await setClipStatus(h.db, row.id, status, "user");
    if (renderStatus !== "none") await setRenderState(h.db, row.id, { renderStatus });
    ids.push(row.id);
  }
  return { id: s.id, clipIds: ids };
}

const post = (id: string) => POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id }) });

describe("POST /api/sessions/[id]/render", () => {
  it("404s for a malformed id and an unknown session", async () => {
    expect((await post("nope")).status).toBe(404);
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("400s when no clip is approved", async () => {
    const { id } = await session("awaiting_review", [["proposed", "none"], ["neutral", "none"], ["rejected", "none"]]);
    const res = await post(id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Approve at least one clip first." });
    expect(h.send).not.toHaveBeenCalled();
    expect((await getSession(h.db, id))?.stage).toBe("awaiting_review");
  });

  it("at awaiting_review moves to rendering and enqueues one resume job", async () => {
    const { id, clipIds } = await session("awaiting_review", [["approved", "none"], ["approved", "none"], ["rejected", "none"]]);
    const res = await post(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 2 });
    // The export page shows them queued until the graph's render node picks them up.
    const statuses = await Promise.all(clipIds.map(async (c) => (await getClip(h.db, c))?.renderStatus));
    expect(statuses).toEqual(["queued", "queued", "none"]);
    const s = await getSession(h.db, id);
    expect([s?.stage, s?.progress]).toEqual(["rendering", 90]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.resume, { sessionId: id, payload: { action: "render" } }, { ...JOB_OPTIONS, singletonKey: id });
  });

  it("409s a second render while the first is running", async () => {
    const { id } = await session("awaiting_review", [["approved", "none"]]);
    expect((await post(id)).status).toBe(200);
    const res = await post(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This video isn't ready for review." });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("503s and restores awaiting_review when the enqueue fails", async () => {
    const { id, clipIds } = await session("awaiting_review", [["approved", "none"]]);
    const log = quietErrors();
    h.send.mockRejectedValueOnce(new Error("db down"));
    const res = await post(id);
    expect(log).toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect(await getSession(h.db, id)).toMatchObject({ stage: "awaiting_review", progress: 70 });
    expect((await getClip(h.db, clipIds[0]!))?.renderStatus).toBe("none");
    expect((await post(id)).status).toBe(200);
  });

  it("after done queues one clip.render per approved clip that is stale, failed or never rendered", async () => {
    const { id, clipIds } = await session("done", [
      ["approved", "stale"],
      ["approved", "done"],
      ["approved", "rendering"],
      ["neutral", "stale"],
    ]);
    const res = await post(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 1 });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(QUEUES.renderClip, { clipId: clipIds[0] }, { ...JOB_OPTIONS, singletonKey: clipIds[0] });
    expect((await getClip(h.db, clipIds[0]!))?.renderStatus).toBe("queued");
    expect((await getClip(h.db, clipIds[1]!))?.renderStatus).toBe("done");
    expect((await getClip(h.db, clipIds[3]!))?.renderStatus).toBe("stale");
    expect((await getSession(h.db, id))?.stage).toBe("done");
  });

  it("after done also re-queues failed and never-rendered approved clips", async () => {
    const { id, clipIds } = await session("done", [["approved", "failed"], ["approved", "none"], ["approved", "queued"]]);
    const res = await post(id);
    expect(await res.json()).toEqual({ queued: 2 });
    expect(h.send.mock.calls.map((c) => (c[1] as { clipId: string }).clipId).sort()).toEqual([clipIds[0], clipIds[1]].sort());
  });

  it("after done 503s and restores the clip's render status when the enqueue fails", async () => {
    const { id, clipIds } = await session("done", [["approved", "stale"]]);
    const log = quietErrors();
    h.send.mockRejectedValueOnce(new Error("db down"));
    const res = await post(id);
    expect(log).toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't queue the job. Please try again." });
    expect((await getClip(h.db, clipIds[0]!))?.renderStatus).toBe("stale");
  });

  it("409s in any other stage", async () => {
    for (const stage of ["transcribing", "awaiting_context", "failed"] as const) {
      const { id } = await session(stage, [["approved", "none"]]);
      const res = await post(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "This video isn't ready for review." });
    }
    expect(h.send).not.toHaveBeenCalled();
  });
});
