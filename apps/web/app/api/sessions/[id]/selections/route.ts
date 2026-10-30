import { OWNER_ID } from "@digestor/core";
import { listSelections } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { readySession } from "@/lib/personal";
import { getServer } from "@/lib/server";

/** GET /api/sessions/[id]/selections — the owner's current selection per moment (no entry = proposed). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  const ready = await readySession(db, id);
  if ("error" in ready) return ready.error;
  return Response.json({ selections: await listSelections(db, OWNER_ID, id) });
}
