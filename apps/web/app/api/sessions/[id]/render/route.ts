import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import { getSession, listClips, setRenderState, transitionStage } from "@digestor/core/server";
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
    for (const clip of todo) await setRenderState(db, clip.id, { renderStatus: "queued" });
    try {
      await boss.send(QUEUES.resume, { sessionId: id, payload: { action: "render" } }, { ...JOB_OPTIONS, singletonKey: id });
    } catch (err) {
      console.error("render: enqueue failed", err);
      for (const clip of todo) await setRenderState(db, clip.id, { renderStatus: clip.renderStatus });
      await transitionStage(db, id, "rendering", "awaiting_review", session.progress);
      return errorResponse(503, QUEUE_FAILED);
    }
    return Response.json({ queued: todo.length });
  }

  const todo = approved.filter((c) => RERENDER.has(c.renderStatus));
  for (const clip of todo) {
    // Marked before sending, so the worker's own queued → rendering → done updates always come after ours.
    await setRenderState(db, clip.id, { renderStatus: "queued" });
    try {
      await boss.send(QUEUES.renderClip, { clipId: clip.id }, { ...JOB_OPTIONS, singletonKey: clip.id });
    } catch (err) {
      console.error("render: enqueue failed", err);
      await setRenderState(db, clip.id, { renderStatus: clip.renderStatus });
      return errorResponse(503, QUEUE_FAILED);
    }
  }
  return Response.json({ queued: todo.length });
}
