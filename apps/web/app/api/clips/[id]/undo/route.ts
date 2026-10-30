import { listClipEvents, undoLastEvent } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";

const NOTHING_TO_UNDO = "There is nothing to undo.";

/**
 * POST /api/clips/[id]/undo — reverts the latest change (also brings back a deleted clip). An optional body
 * `{ "ifActor": "ask" }` makes it conditional: the latest change must have been made by the Ask agent, so the
 * Ask drawer's Undo never reverts something the user did afterwards.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");
  const { db } = getServer();
  const found = await readyClip(db, id, { includeDeleted: true });
  if ("error" in found) return found.error;
  const body: unknown = await request.json().catch(() => null);
  if ((body as { ifActor?: unknown } | null)?.ifActor === "ask") {
    const latest = (await listClipEvents(db, id)).filter((e) => e.undoneAt === null).at(-1);
    if (latest?.actor !== "ask") return errorResponse(409, NOTHING_TO_UNDO);
  }
  const reverted = await undoLastEvent(db, id);
  if (!reverted) return errorResponse(409, NOTHING_TO_UNDO);
  return Response.json(reverted);
}
