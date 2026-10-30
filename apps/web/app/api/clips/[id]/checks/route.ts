import { getMoment } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED, readyClip, sendMomentCheck, sendMomentCheckQuietly } from "@/lib/personal";
import { getServer } from "@/lib/server";

/**
 * GET /api/clips/[id]/checks — `{ checks }`: the clip's moment checks, null while they haven't run (Prepare polls
 * this). While they are null it also asks for them, quietly and at most once per claim (R29) — this covers clips that
 * never went through an approve or confirm, such as the ones Ask made.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");
  const { db, boss } = getServer();
  const found = await readyClip(db, id);
  if ("error" in found) return found.error;
  const moment = found.clip.momentId ? await getMoment(db, found.clip.momentId) : null;
  if (moment && moment.checks === null) await sendMomentCheckQuietly(db, boss, moment.id);
  return Response.json({ checks: moment?.checks ?? null });
}

/**
 * POST /api/clips/[id]/checks — "Check again" after the checks couldn't run: claims and sends a new check.
 * `{ queued: false }` when there is nothing to send (checks exist, or a check is already waiting).
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");
  const { db, boss } = getServer();
  const found = await readyClip(db, id);
  if ("error" in found) return found.error;
  const moment = found.clip.momentId ? await getMoment(db, found.clip.momentId) : null;
  if (!moment || moment.checks !== null) return Response.json({ queued: false });
  try {
    return Response.json({ queued: await sendMomentCheck(db, boss, moment.id) });
  } catch (err) {
    console.error("checks: enqueue failed", err);
    return errorResponse(503, QUEUE_FAILED);
  }
}
