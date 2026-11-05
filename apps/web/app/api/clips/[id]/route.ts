import { z } from "zod";
import { InvalidTimestampError, endsSentence, findBoundaries, freeEdges, parseTimestamp, snapEdges, snapRange } from "@digestor/core";
import { getTranscript, updateClip, type ClipPatch } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { frozenError, midSentenceFor, readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";

const BodySchema = z.union([
  z.object({ start: z.string(), end: z.string(), free: z.literal(true).optional() }).strict(),
  z
    .object({ format: z.enum(["16:9", "9:16"]).optional(), cropOffset: z.number().finite().optional() })
    .strict()
    .refine((b) => b.format !== undefined || b.cropOffset !== undefined),
  z.object({ credit: z.string().max(200).nullable() }).strict(),
  z.object({ noCreditNeeded: z.boolean() }).strict(),
  z.object({ warningsAck: z.boolean() }).strict(),
  z.object({ protectedAck: z.boolean() }).strict(),
  z.object({ extend: z.literal("next") }).strict(),
]);

const FORMAT_ERROR = "Use the format hh:mm:ss or hh:mm:ss.s";
const RANGE_ERROR = "End must be after start and within the video (hh:mm:ss)";
const NO_TRANSCRIPT = "This video has no transcript to snap the cut to.";
const BAD_BODY = "Send one change: new times, format and crop, credit, or an acknowledgement.";
const NOTHING_TO_EXTEND = "There is no later sentence to extend to.";

/**
 * PATCH /api/clips/[id] — one change per request (see BodySchema). Cut times snap to sentence boundaries, only for the edges that changed; `free` (an Alt cut) saves them as given.
 * Once the video is removed, everything but the acknowledgements answers 409.
 */
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
  if (!parsed.success) return errorResponse(400, BAD_BODY);
  const body = parsed.data;

  const { db } = getServer();
  const found = await readyClip(db, id);
  if ("error" in found) return found.error;
  const { clip, session } = found;
  // R30: after the video is removed only the acknowledgements may change.
  const frozen = "warningsAck" in body || "protectedAck" in body ? null : frozenError(session);
  if (frozen) return frozen;

  let patch: ClipPatch;
  if ("start" in body || "extend" in body) {
    let startMs = clip.startMs;
    let endMs = clip.endMs;
    if ("start" in body) {
      try {
        startMs = parseTimestamp(body.start);
        endMs = parseTimestamp(body.end);
      } catch (err) {
        if (err instanceof InvalidTimestampError) return errorResponse(400, FORMAT_ERROR);
        throw err;
      }
    }
    const transcript = await getTranscript(db, session.id);
    if (!transcript) return errorResponse(409, NO_TRANSCRIPT);
    const durationMs = session.durationMs ?? transcript.durationMs;
    if ("extend" in body) {
      const next = transcript.words.find((w) => w.endMs > clip.endMs && endsSentence(w.text));
      if (!next) return errorResponse(409, NOTHING_TO_EXTEND);
      endMs = Math.min(next.endMs, durationMs);
    }
    if (!(startMs >= 0 && startMs < endMs && endMs <= durationMs)) return errorResponse(400, RANGE_ERROR);
    const current = { startMs: clip.startMs, endMs: clip.endMs };
    if ("start" in body && body.free) {
      patch = freeEdges(current, { startMs, endMs });
    } else {
      const boundaries = findBoundaries(transcript.words, durationMs);
      if (boundaries.length < 2) return errorResponse(409, NO_TRANSCRIPT);
      patch =
        "extend" in body
          ? { endMs: snapRange(boundaries, { startMs, endMs }).endMs }
          : snapEdges(boundaries, current, { startMs, endMs });
    }
  } else if ("format" in body || "cropOffset" in body) {
    patch = {};
    if (body.format !== undefined) patch.format = body.format;
    if (body.cropOffset !== undefined) patch.cropOffset = Math.max(-1, Math.min(1, body.cropOffset));
  } else if ("credit" in body) {
    patch = { credit: body.credit === null || body.credit.trim() === "" ? null : body.credit.trim() };
  } else {
    patch = body;
  }
  const updated = await updateClip(db, id, patch, "user");
  return Response.json({ ...updated, midSentence: await midSentenceFor(db, session, updated) });
}
