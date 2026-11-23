import { rm } from "node:fs/promises";
import { z } from "zod";
import { MAX_TRACK_LINES } from "@digestor/core";
import { approveTrack, editTrackCues, getTrack, removeTrack, requestTrackBurn, setTrackLines, unapproveTrack } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { frozenError, readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";
import { lineProblemText } from "@/lib/trackLines";

const ms = z.number().int().min(0).max(24 * 3_600_000);
const LineSchema = z.object({ startMs: ms, endMs: ms, text: z.string().max(1000), from: z.number().int().min(0).nullable() }).strict();

const BodySchema = z.union([
  z.object({ edits: z.array(z.object({ i: z.number().int().min(0), text: z.string().max(1000) }).strict()).min(1).max(2000) }).strict(),
  z.object({ lines: z.array(LineSchema).max(MAX_TRACK_LINES), base: z.string().max(100) }).strict(),
  z.object({ approve: z.boolean() }).strict(),
  z.object({ burn: z.boolean() }).strict(),
]);

/**
 * PATCH /api/tracks/[id] — edit lines' text, save the whole edited list (`lines`: times, deleted and added lines, on
 * top of the lines fingerprinted as `base`), approve the track (or undo the approval), or ask for (or drop) a burned-in version. 409 once the video is removed (R30).
 */
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
  if ("lines" in body) {
    const res = await setTrackLines(db, id, body.lines, body.base);
    if ("track" in res) return Response.json(res.track);
    if ("problems" in res) return errorResponse(400, lineProblemText(res.problems[0]!, (track.builtEndMs ?? 0) - (track.builtStartMs ?? 0)));
    return res.error === "changed" ? errorResponse(409, t("prepare.linesChanged")) : errorResponse(409, "These subtitles aren't ready yet.");
  }
  if (!body.approve) {
    const unapproved = await unapproveTrack(db, id);
    return unapproved ? Response.json(unapproved) : errorResponse(409, "These subtitles aren't ready yet.");
  }
  const approved = await approveTrack(db, id);
  if (approved === "not_ready") return errorResponse(409, "These subtitles aren't ready yet.");
  if (approved === "missing_cues") return errorResponse(400, "Fill every subtitle line before approving.");
  return Response.json(await getTrack(db, id));
}

/**
 * DELETE /api/tracks/[id] — "Remove" a subtitle language that isn't approved (a draft, failed or outdated). 409 when
 * it is approved (undo the approval first), still being prepared or its burned video is being made, and once the
 * video is removed (R30). The track's stored files (an old burned video) are deleted best effort.
 */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Subtitles not found.");
  const { db, storage } = getServer();
  const track = await getTrack(db, id);
  if (!track) return errorResponse(404, "Subtitles not found.");
  const found = await readyClip(db, track.clipId);
  if ("error" in found) {
    return found.error.status === 404 ? errorResponse(404, "Subtitles not found.") : found.error;
  }
  const frozen = frozenError(found.session);
  if (frozen) return frozen;

  const res = await removeTrack(db, id);
  if ("error" in res) {
    if (res.error === "missing") return errorResponse(404, "Subtitles not found.");
    if (res.error === "approved") return errorResponse(409, t("prepare.removeApproved"));
    return errorResponse(409, t("prepare.removeBusy"));
  }
  for (const key of [res.removed.burnKey, res.removed.srtKey, res.removed.vttKey]) {
    if (key) await rm(storage.pathOf(key), { force: true }).catch((e: unknown) => console.error("tracks: removing a file failed", e));
  }
  return new Response(null, { status: 204 });
}
