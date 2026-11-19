import { z } from "zod";
import { JOB_OPTIONS, OWNER_ID, QUEUES } from "@digestor/core";
import { addLibraryQuestion, deleteLibraryAskMessages, existingSessionIds, listLibraryAskMessages } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { QUEUE_FAILED } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ question: z.string().trim().min(1).max(500) }).strict();

/**
 * GET /api/library-ask — the owner's Ask-across-videos conversation, oldest first, and `live`: the sessions its answers
 * cite or list as not searched that still exist (one deleted since renders as plain text).
 */
export async function GET(): Promise<Response> {
  const { db } = getServer();
  const messages = await listLibraryAskMessages(db, OWNER_ID);
  const cited = [...new Set(messages.flatMap((m) => [...(m.sources ?? []), ...(m.notSearched?.videos ?? [])].map((s) => s.sessionId)))];
  const live = await existingSessionIds(db, cited);
  return Response.json({ messages, live: cited.filter((id) => live.has(id)) });
}

/**
 * POST /api/library-ask — `{ question }` (1–500 chars). Stores the question and its `pending` answer (which points at
 * it, so two questions sent at once never swap answers), and queues
 * `ask.library`. Read-only, so nothing else is checked here: the worker answers when no video can be searched. A
 * failed enqueue removes both rows.
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the question as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Ask a question of 1 to 500 characters.");

  const { db, boss } = getServer();
  const { question, answer: pending } = await addLibraryQuestion(db, OWNER_ID, parsed.data.question);
  try {
    await boss.send(QUEUES.askLibrary, { messageId: pending.id }, { ...JOB_OPTIONS, singletonKey: pending.id });
  } catch (err) {
    console.error("library-ask: enqueue failed", err);
    await deleteLibraryAskMessages(db, [question.id, pending.id]).catch((e: unknown) => console.error("library-ask: rollback failed", e));
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json({ question, answer: pending }, { status: 202 });
}
