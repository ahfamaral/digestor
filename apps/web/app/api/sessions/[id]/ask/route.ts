import { z } from "zod";
import { JOB_OPTIONS, OWNER_ID, QUEUES } from "@digestor/core";
import { addAskMessage, deleteAskMessages, listAskMessages } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED, readySession } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ question: z.string().trim().min(1).max(500) }).strict();

/** GET /api/sessions/[id]/ask — the owner's Ask conversation for this video, oldest first, with each answer's actions. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const { db } = getServer();
  return Response.json({ messages: await listAskMessages(db, OWNER_ID, id) });
}

/**
 * POST /api/sessions/[id]/ask — `{ question }` (1–500 chars). Stores the question, then a `pending` answer (inserted
 * second, so the worker's history lookup finds the question), and queues the answer. A failed enqueue removes both.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the question as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Ask a question of 1 to 500 characters.");

  const { db, boss } = getServer();
  const ready = await readySession(db, id);
  if ("error" in ready) return ready.error;

  const question = await addAskMessage(db, { sessionId: id, ownerId: OWNER_ID, role: "user", text: parsed.data.question, status: "done" });
  const pending = await addAskMessage(db, { sessionId: id, ownerId: OWNER_ID, role: "assistant", text: "", status: "pending" });
  try {
    await boss.send(QUEUES.ask, { messageId: pending.id }, { ...JOB_OPTIONS, singletonKey: pending.id });
  } catch (err) {
    console.error("ask: enqueue failed", err);
    await deleteAskMessages(db, [question.id, pending.id]).catch((e: unknown) => console.error("ask: rollback failed", e));
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json({ question, answer: pending }, { status: 202 });
}
