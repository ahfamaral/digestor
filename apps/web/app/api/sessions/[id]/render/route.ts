import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import { claimClipRender, getSession, listClips, setRenderState, transitionStage } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";

const NOT_READY = "This video isn't ready for review.";
const QUEUE_FAILED = "Couldn't queue the job. Please try again.";
/** Render statuses that a render request (re)queues once the session is done. */
const RERENDER = new Set(["none", "failed", "stale"]);

/**
 * POST /api/sessions/[id]/render — render the approved clips.
 * At `awaiting_review` the paused graph is resumed (it renders every approved clip, then marks the session done);
 * at `done` each approved clip that was never rendered, failed or went stale gets its own `clip.render` job.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db, boss } = getServer();
  const session = await getSession(db, id);
  if (!session) return errorResponse(404, "Session not found.");
  if (session.stage !== "awaiting_review" && session.stage !== "done") return errorResponse(409, NOT_READY);

  const approved = (await listClips(db, id)).filter((c) => c.status === "approved");
  if (approved.length === 0) return errorResponse(400, "Approve at least one clip first.");

  if (session.stage === "awaiting_review") {
    // Atomic: only one concurrent request wins the transition.
    if (!(await transitionStage(db, id, "awaiting_review", "rendering", 90))) return errorResponse(409, NOT_READY);
    // Shown as queued on the export page until the graph's render node picks them up.
    const todo = approved.filter((c) => c.renderStatus !== "done");
    try {
      for (const clip of todo) await setRenderState(db, clip.id, { renderStatus: "queued" });
      await boss.send(QUEUES.resume, { sessionId: id, payload: { action: "render" } }, { ...JOB_OPTIONS, singletonKey: id });
    } catch (err) {
      console.error("render: enqueue failed", err);
      try {
        for (const clip of todo) await setRenderState(db, clip.id, { renderStatus: clip.renderStatus });
        await transitionStage(db, id, "rendering", "awaiting_review", session.progress);
      } catch (rollbackErr) {
        console.error("render: rollback failed", rollbackErr);
      }
      return errorResponse(503, QUEUE_FAILED);
    }
    return Response.json({ queued: todo.length });
  }

  // Each clip is claimed atomically (none/failed/stale → queued) before its job is sent, so concurrent
  // requests enqueue at most one job per clip; pg-boss singletonKey is not relied on for that.
  let queued = 0;
  for (const clip of approved.filter((c) => RERENDER.has(c.renderStatus))) {
    let claimed = false;
    try {
      claimed = await claimClipRender(db, clip.id);
      if (!claimed) continue;
      await boss.send(QUEUES.renderClip, { clipId: clip.id }, { ...JOB_OPTIONS, singletonKey: clip.id });
      queued++;
    } catch (err) {
      console.error("render: enqueue failed", err);
      if (claimed) await setRenderState(db, clip.id, { renderStatus: clip.renderStatus }).catch((e: unknown) => console.error("render: rollback failed", e));
      return errorResponse(503, QUEUE_FAILED);
    }
  }
  return Response.json({ queued });
}
