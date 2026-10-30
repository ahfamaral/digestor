import { z } from "zod";
import { OWNER_ID } from "@digestor/core";
import { confirmClips, getAnalysisVersion, getMoment, listSelections } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { VIDEO_REMOVED, readySession, sendMomentCheckQuietly } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ momentIds: z.array(z.string().uuid()).max(500) }).strict();

/**
 * POST /api/sessions/[id]/clips — "Confirm selection". Makes a clip (bounds = the moment's) for each listed moment that
 * is approved and has none yet, and returns the clips of those moments. Safe to repeat.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the moments as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Send the list of moment ids to confirm.");

  const { db, boss } = getServer();
  const ready = await readySession(db, id);
  if ("error" in ready) return ready.error;
  if (ready.session.videoDeletedAt) return errorResponse(409, VIDEO_REMOVED);

  const momentIds = [...new Set(parsed.data.momentIds)];
  const selections = await listSelections(db, OWNER_ID, id);
  const wanted = [];
  for (const momentId of momentIds) {
    if (selections[momentId] !== "approved") continue;
    const moment = await getMoment(db, momentId);
    if (!moment || (moment.ownerId !== null && moment.ownerId !== OWNER_ID)) continue;
    if ((await getAnalysisVersion(db, moment.analysisId))?.sessionId !== id) continue;
    wanted.push(moment);
  }
  const result = await confirmClips(db, OWNER_ID, id, wanted);
  for (const moment of wanted) if (moment.checks === null) await sendMomentCheckQuietly(db, boss, moment.id);
  return Response.json({ clips: result });
}
