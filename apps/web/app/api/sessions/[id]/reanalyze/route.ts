import { z } from "zod";
import { JOB_OPTIONS, PROFILES, ProfileIdSchema, QUEUES } from "@digestor/core";
import { claimAnalysisVersion, failAnalysisVersion } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED, readySession } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ profile: ProfileIdSchema, reason: z.string().trim().min(1).max(500).optional() }).strict();

/** POST /api/sessions/[id]/reanalyze — `{ profile }`: starts a new analysis version; 409 while one is running. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the profile as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Choose what kind of video this is.");

  const { db, boss } = getServer();
  const ready = await readySession(db, id);
  if ("error" in ready) return ready.error;

  const { profile } = parsed.data;
  const reason = parsed.data.reason ?? `Re-analysed as ${PROFILES[profile].label}`;
  // Claimed in the database (queues are standard, so the job layer can't dedupe): one running version per session.
  const claimed = await claimAnalysisVersion(db, id, { profile, reason });
  if (!claimed) return errorResponse(409, "A re-analysis is already running for this video.");
  try {
    await boss.send(QUEUES.reanalyze, { sessionId: id, profile, reason, analysisId: claimed.id }, JOB_OPTIONS);
  } catch (err) {
    console.error("reanalyze: enqueue failed", err);
    await failAnalysisVersion(db, claimed.id).catch((e: unknown) => console.error("reanalyze: rollback failed", e));
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json({ status: "queued", analysisId: claimed.id }, { status: 202 });
}
