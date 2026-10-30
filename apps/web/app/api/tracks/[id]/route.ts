import { z } from "zod";
import { approveTrack, editTrackCues, getClip, getSession, getTrack, requestTrackBurn } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { NOT_READY } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.union([
  z.object({ edits: z.array(z.object({ i: z.number().int().min(0), text: z.string().max(1000) }).strict()).min(1).max(2000) }).strict(),
  z.object({ approve: z.literal(true) }).strict(),
  z.object({ burn: z.boolean() }).strict(),
]);

/** PATCH /api/tracks/[id] — edit lines, approve the track, or ask for (or drop) a burned-in version. */
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
  const clip = track ? await getClip(db, track.clipId) : null;
  if (!track || !clip) return errorResponse(404, "Subtitles not found.");
  const session = await getSession(db, clip.sessionId);
  if (!session) return errorResponse(404, "Subtitles not found.");
  if (session.stage !== "ready") return errorResponse(409, NOT_READY);

  if ("burn" in body) return Response.json(await requestTrackBurn(db, id, body.burn));
  if (track.status !== "ready") return errorResponse(409, "These subtitles aren't ready yet.");
  if ("edits" in body) return Response.json(await editTrackCues(db, id, body.edits));
  if ((await approveTrack(db, id)) === "missing_cues") return errorResponse(400, "Fill every subtitle line before approving.");
  return Response.json(await getTrack(db, id));
}
