import { z } from "zod";
import { JOB_OPTIONS, PROFILES, ProfileIdSchema, QUEUES } from "@digestor/core";
import { getRunningAnalysis } from "@digestor/core/server";
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
  if (await getRunningAnalysis(db, id)) return errorResponse(409, "A re-analysis is already running for this video.");

  const { profile } = parsed.data;
  const reason = parsed.data.reason ?? `Re-analysed as ${PROFILES[profile].label}`;
  try {
    // The worker creates the version row, so the singleton key stops a double click from queueing two.
    await boss.send(QUEUES.reanalyze, { sessionId: id, profile, reason }, { ...JOB_OPTIONS, singletonKey: `reanalyze:${id}` });
  } catch (err) {
    console.error("reanalyze: enqueue failed", err);
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json({ status: "queued" }, { status: 202 });
}
