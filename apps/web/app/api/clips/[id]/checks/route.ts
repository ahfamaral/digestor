import { getMoment } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";

/** GET /api/clips/[id]/checks — `{ checks }`: the clip's moment checks, null while they haven't run (Prepare polls this). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");
  const { db } = getServer();
  const found = await readyClip(db, id);
  if ("error" in found) return found.error;
  const moment = found.clip.momentId ? await getMoment(db, found.clip.momentId) : null;
  return Response.json({ checks: moment?.checks ?? null });
}
