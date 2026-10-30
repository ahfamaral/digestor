import { z } from "zod";
import { OWNER_ID } from "@digestor/core";
import {
  confirmBulkSelection, getAskAction, getAskMessage, getMoment, resolveAskAction,
} from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { readySession, sendMomentCheckQuietly, sessionIdOfMoment } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ decision: z.enum(["confirm", "dismiss"]) }).strict();
const PayloadSchema = z.object({
  momentIds: z.array(z.string().uuid()).max(500),
  status: z.enum(["approved", "neutral", "rejected"]).nullable(),
});

const NOT_PENDING = "This suggestion was already handled.";

/** POST /api/ask-actions/[id] — `{ decision: "confirm" | "dismiss" }`. Confirming applies every selection at once. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Suggestion not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the decision as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Choose confirm or dismiss.");

  const { db, boss } = getServer();
  const action = await getAskAction(db, id);
  const message = action ? await getAskMessage(db, action.messageId) : null;
  if (!action || !message || message.ownerId !== OWNER_ID) return errorResponse(404, "Suggestion not found.");
  if (action.status !== "pending") return errorResponse(409, NOT_PENDING);

  if (parsed.data.decision === "dismiss") {
    if (!(await resolveAskAction(db, id, "dismissed"))) return errorResponse(409, NOT_PENDING);
    return Response.json({ status: "dismissed" });
  }

  const ready = await readySession(db, message.sessionId);
  if ("error" in ready) return ready.error;
  const payload = PayloadSchema.safeParse(action.payload);
  if (!payload.success) return errorResponse(409, "This suggestion can't be applied.");

  // Only moments of this video that the owner may see; anything else in the payload is ignored.
  const moments = [];
  for (const momentId of new Set(payload.data.momentIds)) {
    const moment = await getMoment(db, momentId);
    if (!moment || (moment.ownerId !== null && moment.ownerId !== OWNER_ID)) continue;
    if ((await sessionIdOfMoment(db, momentId)) !== message.sessionId) continue;
    moments.push(moment);
  }
  const { status } = payload.data;
  if (!(await confirmBulkSelection(db, OWNER_ID, id, moments.map((m) => m.id), status))) return errorResponse(409, NOT_PENDING);
  if (status === "approved") for (const m of moments) if (m.checks === null) await sendMomentCheckQuietly(boss, m.id);
  return Response.json({ status: "confirmed", applied: moments.length });
}
