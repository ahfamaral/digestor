import { getSession, listClips } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { buildClipTree } from "@/lib/review";
import { getServer } from "@/lib/server";

/** GET /api/sessions/[id]/clips — `{ stage, clips }`: the session stage and its clips as a tree (`{ ...parent, children }[]`). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  const session = await getSession(db, id);
  if (!session) return errorResponse(404, "Session not found.");
  return Response.json({ stage: session.stage, clips: buildClipTree(await listClips(db, id)) });
}
