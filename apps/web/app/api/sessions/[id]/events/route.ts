import { getSession } from "@digestor/core/server";
import { isUuid } from "@/lib/ids";
import { errorResponse } from "@/lib/http";
import { getServer } from "@/lib/server";
import { sessionEventStream } from "@/lib/sessionEvents";

/** GET /api/sessions/[id]/events — server-sent progress for the Processing screen. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  return new Response(sessionEventStream(db, id, request.signal), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
