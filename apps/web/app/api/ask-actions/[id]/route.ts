import { z } from "zod";
import { JOB_OPTIONS, OWNER_ID, QUEUES, type AskAction, type ToolApprovalPayload, type ToolApprovalResolution } from "@digestor/core";
import {
  confirmBulkSelection, getAskAction, getAskMessage, getMoment, getSession, reopenToolApproval, resolveAskAction, resolveToolApproval, staleCardClips,
} from "@digestor/core/server";
import { readEdits } from "@/lib/askEdits";
import { asSelectionStatus, parseApprovalPayload, staleLine } from "@/lib/askText";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED, VIDEO_REMOVED, readySession, sendMomentCheckQuietly, sessionIdOfMoment } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BulkBodySchema = z.object({ decision: z.enum(["confirm", "dismiss"]) }).strict();
const ApprovalBodySchema = z.union([
  z.object({ decision: z.enum(["approve", "reject"]) }).strict(),
  z.object({ decision: z.literal("edit"), edits: z.array(z.object({ id: z.string().min(1).max(200), args: z.unknown().refine((v) => v !== undefined) }).strict()).min(1).max(20) }).strict(),
]);
const PayloadSchema = z.object({
  momentIds: z.array(z.string().uuid()).max(500),
  // Stored payloads may still say "neutral" (read as skipped).
  status: z.unknown().transform((v) => (v === null ? null : (asSelectionStatus(v) ?? undefined))).refine((v) => v !== undefined),
});

const NOT_PENDING = "This suggestion was already handled.";
const BAD_EDIT = "Check the changes: times as hh:mm:ss with the end after the start, a title, at least one moment or clip, and a subtitle language from the list.";

/**
 * POST /api/ask-actions/[id]. A `bulk_selection` card takes `{ decision: "confirm" | "dismiss" }`; confirming applies
 * every selection at once. A `tool_approval` card (an Ask answer paused before a change) takes `{ decision: "approve"
 * | "reject" }` or `{ decision: "edit", edits: [{ id, args }] }`: the decision is stored with a compare-and-set from
 * `pending` (a second click or tab gets 409), then one `ask.resume` job continues the answer in the worker.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Suggestion not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the decision as JSON.");
  }

  const { db } = getServer();
  const action = await getAskAction(db, id);
  const message = action ? await getAskMessage(db, action.messageId) : null;
  if (!action || !message || message.ownerId !== OWNER_ID) return errorResponse(404, "Suggestion not found.");
  if (action.kind === "tool_approval") return decideApproval(raw, action, message.status, message.sessionId);

  const parsed = BulkBodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Choose confirm or dismiss.");
  if (action.status !== "pending") return errorResponse(409, NOT_PENDING);
  return decideBulk(parsed.data.decision, action, message.sessionId);
}

async function decideApproval(raw: unknown, action: AskAction, messageStatus: string, sessionId: string): Promise<Response> {
  const { db, boss } = getServer();
  const parsed = ApprovalBodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Choose approve, edit or reject.");
  if (action.status !== "pending" || messageStatus !== "waiting") return errorResponse(409, NOT_PENDING);

  let resolution: ToolApprovalResolution = { decision: parsed.data.decision };
  if (parsed.data.decision !== "reject") {
    // A change can't be made once the video is gone (R30); rejecting still lets the answer finish.
    const session = await getSession(db, sessionId);
    if (!session) return errorResponse(404, "Suggestion not found.");
    if (session.videoDeletedAt) return errorResponse(409, VIDEO_REMOVED);
    // A clip changed by hand (or removed) since the card was made: nothing is applied; the answer ends as a refusal.
    const cardClips = (parseApprovalPayload(action.payload)?.calls ?? []).flatMap((c) => c.clips ?? []);
    const stale = cardClips.length > 0 ? await staleCardClips(db, OWNER_ID, cardClips) : [];
    if (stale.length > 0) {
      if (!(await resolveToolApproval(db, action.id, { decision: "reject", stale }))) return errorResponse(409, NOT_PENDING);
      try {
        await boss.send(QUEUES.askResume, { actionId: action.id }, { ...JOB_OPTIONS, singletonKey: action.id });
      } catch (err) {
        console.error("ask-actions: enqueue failed", err);
        await reopenToolApproval(db, action.id).catch((e: unknown) => console.error("ask-actions: reopening the card failed", e));
        return errorResponse(503, QUEUE_FAILED);
      }
      return errorResponse(409, staleLine(stale));
    }
    if (parsed.data.decision === "edit") {
      const edits = readEdits(action.payload as ToolApprovalPayload, parsed.data.edits as { id: string; args: unknown }[], { sessionLanguage: session.language });
      if (!edits) return errorResponse(400, BAD_EDIT);
      resolution = { decision: "edit", edits };
    }
  }

  if (!(await resolveToolApproval(db, action.id, resolution))) return errorResponse(409, NOT_PENDING);
  try {
    await boss.send(QUEUES.askResume, { actionId: action.id }, { ...JOB_OPTIONS, singletonKey: action.id });
  } catch (err) {
    console.error("ask-actions: enqueue failed", err);
    await reopenToolApproval(db, action.id).catch((e: unknown) => console.error("ask-actions: reopening the card failed", e));
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json({ status: resolution.decision === "reject" ? "dismissed" : "confirmed" });
}

async function decideBulk(decision: "confirm" | "dismiss", action: AskAction, sessionId: string): Promise<Response> {
  const { db, boss } = getServer();
  if (decision === "dismiss") {
    if (!(await resolveAskAction(db, action.id, "dismissed"))) return errorResponse(409, NOT_PENDING);
    return Response.json({ status: "dismissed" });
  }

  const ready = await readySession(db, sessionId);
  if ("error" in ready) return ready.error;
  const payload = PayloadSchema.safeParse(action.payload);
  if (!payload.success) return errorResponse(409, "This suggestion can't be applied.");

  // Only moments of this video that the owner may see; anything else in the payload is ignored.
  const moments = [];
  for (const momentId of new Set(payload.data.momentIds)) {
    const moment = await getMoment(db, momentId);
    if (!moment || (moment.ownerId !== null && moment.ownerId !== OWNER_ID)) continue;
    if ((await sessionIdOfMoment(db, momentId)) !== sessionId) continue;
    moments.push(moment);
  }
  const { status } = payload.data;
  if (!(await confirmBulkSelection(db, OWNER_ID, action.id, moments.map((m) => m.id), status))) return errorResponse(409, NOT_PENDING);
  if (status === "approved") for (const m of moments) if (m.checks === null) await sendMomentCheckQuietly(db, boss, m.id);
  return Response.json({ status: "confirmed", applied: moments.length });
}
