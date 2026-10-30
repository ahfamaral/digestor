import { z } from "zod";
import { JOB_OPTIONS, OWNER_ID, QUEUES, exportChecklist, type ProfileId } from "@digestor/core";
import {
  claimClipRender, claimTrackBurn, getMoment, listClips, listTracks, setClipRenderStatus, setTrackBurnStatus,
} from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED, VIDEO_REMOVED, readySession, sendMomentCheckQuietly } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ clipIds: z.array(z.string().uuid()).min(1).max(200) }).strict();

/**
 * POST /api/sessions/[id]/export — `{ clipIds }`. Renders each clip whose checklist is all ok, and burns each approved
 * track that asked for it. Every render and burn is claimed in the database before its job is sent, so parallel
 * requests queue at most one job each. Clips that fail the checklist are listed in `blocked`; when nothing at all can
 * be exported the answer is 400.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the clips as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Choose at least one clip to export.");

  const { db, boss } = getServer();
  const ready = await readySession(db, id);
  if ("error" in ready) return ready.error;
  const { session } = ready;
  if (session.videoDeletedAt) return errorResponse(409, VIDEO_REMOVED);

  const all = new Map((await listClips(db, OWNER_ID, id)).map((c) => [c.id, c]));
  const wanted = [...new Set(parsed.data.clipIds)].map((cid) => all.get(cid));
  if (wanted.some((c) => c === undefined)) return errorResponse(400, "Choose clips from this video.");
  const profile = (session.profile ?? "other") as ProfileId;

  const blocked: { clipId: string; failing: string[] }[] = [];
  const exportable = [];
  for (const clip of wanted) {
    if (!clip) continue;
    const moment = clip.momentId ? await getMoment(db, clip.momentId) : null;
    if (moment && moment.checks === null) await sendMomentCheckQuietly(db, boss, moment.id);
    const tracks = await listTracks(db, clip.id);
    const failing = exportChecklist({ clip, moment, tracks, profile }).filter((i) => !i.ok).map((i) => i.id);
    if (failing.length > 0) blocked.push({ clipId: clip.id, failing });
    else exportable.push({ clip, tracks });
  }
  if (exportable.length === 0) {
    return Response.json({ error: "Some clips still need attention before they can be exported.", blocked }, { status: 400 });
  }

  let queuedClips = 0;
  let queuedBurns = 0;
  for (const { clip, tracks } of exportable) {
    let claimed = false;
    try {
      claimed = await claimClipRender(db, clip.id);
      if (claimed) {
        await boss.send(QUEUES.renderClip, { clipId: clip.id }, { ...JOB_OPTIONS, singletonKey: clip.id });
        queuedClips++;
      }
    } catch (err) {
      console.error("export: enqueue failed", err);
      if (claimed) await setClipRenderStatus(db, clip.id, clip.renderStatus).catch((e: unknown) => console.error("export: rollback failed", e));
      return errorResponse(503, QUEUE_FAILED);
    }
    for (const track of tracks) {
      if (track.approvedAt === null || track.burnStatus === "none") continue; // no burn requested
      let burnClaimed = false;
      try {
        burnClaimed = await claimTrackBurn(db, track.id);
        if (burnClaimed) {
          await boss.send(QUEUES.burnTrack, { trackId: track.id }, { ...JOB_OPTIONS, singletonKey: track.id });
          queuedBurns++;
        }
      } catch (err) {
        console.error("export: enqueue failed", err);
        if (burnClaimed) await setTrackBurnStatus(db, track.id, track.burnStatus).catch((e: unknown) => console.error("export: rollback failed", e));
        return errorResponse(503, QUEUE_FAILED);
      }
    }
  }
  return Response.json({ queued: queuedClips, burns: queuedBurns, blocked });
}
