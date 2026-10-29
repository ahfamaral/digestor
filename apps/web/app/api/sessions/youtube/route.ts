import { z } from "zod";
import { InvalidYouTubeUrlError, parseYouTubeUrl } from "@digestor/core";
import { createSession } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { sendStart } from "@/lib/jobs";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ url: z.string(), hint: z.string().optional() });

/** POST /api/sessions/youtube { url, hint? } — the worker downloads the video. */
export async function POST(req: Request): Promise<Response> {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "Paste a YouTube link.");

  let url: string;
  try {
    url = parseYouTubeUrl(parsed.data.url).url;
  } catch (err) {
    if (err instanceof InvalidYouTubeUrlError) return errorResponse(400, err.message);
    throw err;
  }

  const { db, boss } = getServer();
  const hint = parsed.data.hint?.trim() || null;
  // The title is the link until the download step fills in the real one.
  const session = await createSession(db, { title: url, source: "youtube", sourceUrl: url, hint });
  await sendStart(boss, session.id);
  return Response.json({ sessionId: session.id });
}
