import { JOB_OPTIONS, QUEUES, ResumePayloadSchema } from "@digestor/core";
import { getContextCard, getSession, setStage } from "@digestor/core/server";
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
  if (!parsed.success || parsed.data.action === "render") {
    return errorResponse(400, "Send either continue (with answers) or skip.");
  }
  const payload = parsed.data;

  const { db, boss } = getServer();
  const session = await getSession(db, id);
  if (!session) return errorResponse(404, "Session not found.");
  if (session.stage !== "awaiting_context") return errorResponse(409, "This video isn't waiting for context.");

  if (payload.action === "continue") await setStage(db, id, "understanding", 55);
  else await setStage(db, id, "finding_clips", 70);
  await boss.send(QUEUES.resume, { sessionId: id, payload }, { ...JOB_OPTIONS, singletonKey: id });
  return Response.json({ ok: true });
}
