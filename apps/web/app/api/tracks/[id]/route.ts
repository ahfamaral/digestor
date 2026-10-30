import { z } from "zod";
import { approveTrack, editTrackCues, getTrack, requestTrackBurn } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { frozenError, readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.union([
  z.object({ edits: z.array(z.object({ i: z.number().int().min(0), text: z.string().max(1000) }).strict()).min(1).max(2000) }).strict(),
  z.object({ approve: z.literal(true) }).strict(),
  z.object({ burn: z.boolean() }).strict(),
]);

/** PATCH /api/tracks/[id] — edit lines, approve the track, or ask for (or drop) a burned-in version. 409 once the video is removed (R30). */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Subtitles not found.");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the change as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Send line edits, approve, or burn.");
  const body = parsed.data;

  const { db } = getServer();
  const track = await getTrack(db, id);
  if (!track) return errorResponse(404, "Subtitles not found.");
  const found = await readyClip(db, track.clipId);
  if ("error" in found) {
    return found.error.status === 404 ? errorResponse(404, "Subtitles not found.") : found.error;
  }
  const frozen = frozenError(found.session);
  if (frozen) return frozen;

  if ("burn" in body) {
    const updated = await requestTrackBurn(db, id, body.burn);
    if (!body.burn && (updated?.burnStatus === "queued" || updated?.burnStatus === "rendering")) {
      return errorResponse(409, "The burned-in version is being made; try again when it finishes.");
    }
    return Response.json(updated);
  }
  if (track.status !== "ready") return errorResponse(409, "These subtitles aren't ready yet.");
  if ("edits" in body) return Response.json(await editTrackCues(db, id, body.edits));
  const approved = await approveTrack(db, id);
  if (approved === "not_ready") return errorResponse(409, "These subtitles aren't ready yet.");
  if (approved === "missing_cues") return errorResponse(400, "Fill every subtitle line before approving.");
  return Response.json(await getTrack(db, id));
}
