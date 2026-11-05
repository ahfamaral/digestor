import { z } from "zod";
import { OWNER_ID } from "@digestor/core";
import { getMoment, setSelection } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { readySession, sendMomentCheckQuietly, sessionIdOfMoment } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ status: z.enum(["approved", "rejected"]).nullable() }).strict();

/** PUT /api/moments/[id]/selection — `{ status }`; null clears it back to "proposed". Approving queues the clip checks once. */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Moment not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the change as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Choose approved, skipped or null.");

  const { db, boss } = getServer();
  const moment = await getMoment(db, id);
  const sessionId = moment ? await sessionIdOfMoment(db, id) : null;
  if (!moment || !sessionId || (moment.ownerId !== null && moment.ownerId !== OWNER_ID)) {
    return errorResponse(404, "Moment not found.");
  }
  const ready = await readySession(db, sessionId);
  if ("error" in ready) return ready.error;

  const { status } = parsed.data;
  await setSelection(db, OWNER_ID, id, status);
  if (status === "approved" && moment.checks === null) await sendMomentCheckQuietly(db, boss, id);
  return Response.json({ status });
}
