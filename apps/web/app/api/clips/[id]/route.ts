import { z } from "zod";
import { ClipStatusSchema, InvalidTimestampError, findBoundaries, parseTimestamp, snapRange } from "@digestor/core";
import { getClip, getSession, getTranscript, setClipBounds, setClipStatus, type Stage } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";

const BodySchema = z.union([
  z.object({ status: ClipStatusSchema }).strict(),
  z.object({ start: z.string(), end: z.string() }).strict(),
]);

const REVIEW_STAGES: readonly Stage[] = ["awaiting_review", "done"];
const FORMAT_ERROR = "Use the format hh:mm:ss or hh:mm:ss.s";
const RANGE_ERROR = "End must be after start and within the video (hh:mm:ss)";
const NO_TRANSCRIPT = "This video has no transcript to snap the cut to.";

/** PATCH /api/clips/[id] — `{ status }` or `{ start, end }` (timestamps; snapped to sentence/pause boundaries). */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Clip not found.");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Send the change as JSON.");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Send either a status or start and end times.");
  const body = parsed.data;

  const { db } = getServer();
  const clip = await getClip(db, id);
  if (!clip) return errorResponse(404, "Clip not found.");
  const session = await getSession(db, clip.sessionId);
  if (!session || !REVIEW_STAGES.includes(session.stage)) return errorResponse(409, "This video isn't ready for review.");

  if ("status" in body) return Response.json(await setClipStatus(db, id, body.status, "user"));

  let startMs: number;
  let endMs: number;
  try {
    startMs = parseTimestamp(body.start);
    endMs = parseTimestamp(body.end);
  } catch (err) {
    if (err instanceof InvalidTimestampError) return errorResponse(400, FORMAT_ERROR);
    throw err;
  }

  const transcript = await getTranscript(db, session.id);
  if (!transcript) return errorResponse(409, NO_TRANSCRIPT);
  const durationMs = session.durationMs ?? transcript.durationMs;
  if (!(startMs >= 0 && startMs < endMs && endMs <= durationMs)) return errorResponse(400, RANGE_ERROR);

  const boundaries = findBoundaries(transcript.words, durationMs);
  if (boundaries.length < 2) return errorResponse(409, NO_TRANSCRIPT);
  const snapped = snapRange(boundaries, { startMs, endMs });
  return Response.json(await setClipBounds(db, id, snapped, "user"));
}
