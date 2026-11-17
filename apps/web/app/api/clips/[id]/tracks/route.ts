import { z } from "zod";
import { JOB_OPTIONS, LANGUAGES, QUEUES } from "@digestor/core";
import { createTrack, deleteFailedTrack, deleteTrack, listTracks, type Db, type Track } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED, frozenError, readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ language: z.string().min(2).max(35) }).strict();

/**
 * A new track for the language; when one exists and has failed or is outdated (built for an older cut), it is
 * replaced ("Try again", "Rebuild"). Null when a track in that language is preparing or ready.
 */
async function createOrRetry(db: Db, clipId: string, language: string): Promise<Track | null> {
  const created = await createTrack(db, clipId, language);
  if (created) return created;
  const existing = (await listTracks(db, clipId)).find((t) => t.language === language);
  const replaceable = existing?.status === "failed" || existing?.status === "outdated";
  if (!existing || !replaceable || !(await deleteFailedTrack(db, existing.id))) return null;
  return createTrack(db, clipId, language); // null if a parallel retry got there first
}

/**
 * POST /api/clips/[id]/tracks — `{ language }`: starts a subtitle track (one per clip and language), or rebuilds a failed or
 * outdated one. 409 `VIDEO_REMOVED` once the session's video is removed (R30).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the language as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Choose a subtitle language.");
  const language = parsed.data.language;

  const { db, boss } = getServer();
  const found = await readyClip(db, id);
  if ("error" in found) return found.error;
  const { session } = found;
  const frozen = frozenError(session); // R30: no new or rebuilt draft once the video is removed
  if (frozen) return frozen;

  const known = LANGUAGES.some((l) => l.code === language) || (session.language !== null && session.language === language);
  if (!known) return errorResponse(400, "That subtitle language isn't available.");

  const track = await createOrRetry(db, id, language);
  if (!track) return errorResponse(409, "This clip already has subtitles in that language.");
  try {
    await boss.send(QUEUES.prepareTrack, { trackId: track.id }, { ...JOB_OPTIONS, singletonKey: track.id });
  } catch (err) {
    console.error("tracks: enqueue failed", err);
    await deleteTrack(db, track.id).catch((e: unknown) => console.error("tracks: rollback failed", e));
    return errorResponse(503, QUEUE_FAILED);
  }
  return Response.json(track, { status: 201 });
}

/** GET /api/clips/[id]/tracks — `{ tracks }`: the clip's subtitle tracks (Prepare polls this while one is preparing). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");
  const { db } = getServer();
  const found = await readyClip(db, id);
  if ("error" in found) return found.error;
  return Response.json({ tracks: await listTracks(db, id) });
}
