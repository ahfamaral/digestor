import { getClipAny, getSession, undoLastEvent } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { NOT_READY } from "@/lib/personal";
import { getServer } from "@/lib/server";

/** POST /api/clips/[id]/undo — reverts the latest change (also brings back a deleted clip). */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");
  const { db } = getServer();
  const clip = await getClipAny(db, id);
  if (!clip) return errorResponse(404, "Clip not found.");
  const session = await getSession(db, clip.sessionId);
  if (!session) return errorResponse(404, "Clip not found.");
  if (session.stage !== "ready") return errorResponse(409, NOT_READY);
  const reverted = await undoLastEvent(db, id);
  if (!reverted) return errorResponse(409, "There is nothing to undo.");
  return Response.json(reverted);
}
