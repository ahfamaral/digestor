import { OWNER_ID } from "@digestor/core";
import { mergeClips } from "@digestor/core/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { frozenError, midSentenceFor, readyClip } from "@/lib/personal";
import { getServer } from "@/lib/server";

const Body = z.strictObject({ clipIds: z.tuple([z.string().refine(isUuid), z.string().refine(isUuid)]) });

/**
 * POST /api/clips/merge — joins two overlapping or touching clips into the earlier one (the other is absorbed;
 * Undo on the survivor splits them again). 409 once the video is removed (R30).
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.clipIds[0] === parsed.data.clipIds[1]) return errorResponse(400, "Send the two clips to merge.");
  const ids = parsed.data.clipIds;
  const { db } = getServer();
  const found = await readyClip(db, ids[0]);
  if ("error" in found) return found.error;
  const frozen = frozenError(found.session);
  if (frozen) return frozen;
  const result = await mergeClips(db, OWNER_ID, ids, "user");
  if (!result.ok) {
    return result.reason === "not_touching"
      ? errorResponse(409, "Only clips that overlap or touch can be merged.")
      : errorResponse(409, "One of these clips no longer exists. Reload the page and try again.");
  }
  return Response.json({ ...result.clip, midSentence: await midSentenceFor(db, found.session, result.clip) });
}
