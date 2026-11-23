import { OWNER_ID } from "@digestor/core";
import { archiveAskConversation, getSession } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";

/**
 * POST /api/sessions/[id]/ask/archive — "New conversation": archives the owner's current Ask conversation on this video
 * (Ask stops replaying it; the drawer lists it under "Earlier conversations"). 409 while an answer is being written or
 * waits at an approval card; 200 `{ archived: 0 }` when there was nothing to archive.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  const res = await archiveAskConversation(db, OWNER_ID, id);
  if ("error" in res) return res.error === "busy" ? errorResponse(409, t("ask.newConversationBusy")) : Response.json({ archived: 0 });
  return Response.json(res);
}
