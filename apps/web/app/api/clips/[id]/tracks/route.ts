import { z } from "zod";
import { JOB_OPTIONS, LANGUAGES, QUEUES } from "@digestor/core";
import { createTrack, deleteTrack } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { QUEUE_FAILED, readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ language: z.string().min(2).max(35) }).strict();

/** POST /api/clips/[id]/tracks — `{ language }`: starts a subtitle track (one per clip and language). */
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

  const known = LANGUAGES.some((l) => l.code === language) || (session.language !== null && session.language === language);
  if (!known) return errorResponse(400, "That subtitle language isn't available.");

  const track = await createTrack(db, id, language);
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
