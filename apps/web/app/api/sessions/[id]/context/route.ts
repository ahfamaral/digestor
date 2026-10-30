import { JOB_OPTIONS, QUEUES, ResumePayloadSchema } from "@digestor/core";
import { getContextCard, getSession, transitionStage } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sessions/[id]/context — the current context card and round. */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const found = await getContextCard(getServer().db, id);
  if (!found) return errorResponse(404, "No context card yet.");
  return Response.json({ card: found.card, round: found.round });
}

/** POST /api/sessions/[id]/context — answer (continue) or skip; resumes the pipeline. */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the answers as JSON.");
  }
  const parsed = ResumePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "Send either continue (with answers) or skip.");
  }
  const payload = parsed.data;

  const { db, boss } = getServer();
  if (!(await getSession(db, id))) return errorResponse(404, "Session not found.");
  const next = payload.action === "continue" ? ({ stage: "understanding", progress: 55 } as const) : ({ stage: "indexing", progress: 70 } as const);
  // Atomic: only one concurrent request wins the transition.
  if (!(await transitionStage(db, id, "awaiting_context", next.stage, next.progress))) {
    return errorResponse(409, "This video isn't waiting for context.");
  }
  try {
    await boss.send(QUEUES.resume, { sessionId: id, payload }, { ...JOB_OPTIONS, singletonKey: id });
  } catch (err) {
    console.error("context: enqueue failed", err);
    await transitionStage(db, id, next.stage, "awaiting_context", 55);
    return errorResponse(503, "Couldn't queue the job. Please try again.");
  }
  return Response.json({ ok: true });
}
