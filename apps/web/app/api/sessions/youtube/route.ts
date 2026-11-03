import { z } from "zod";
import { InvalidYouTubeUrlError, parseYouTubeUrl } from "@digestor/core";
import { createSession, linkRecord } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { readRecordInput } from "@/lib/recordInput";
import { sendStart } from "@/lib/jobs";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ url: z.string(), hint: z.string().optional(), record: z.string().optional() });

/** POST /api/sessions/youtube { url, hint?, record? } — the worker downloads the video. */
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

  const record = readRecordInput(parsed.data.record);
  if ("error" in record) return record.error;

  const { db, boss } = getServer();
  const hint = parsed.data.hint?.trim() || null;
  // The title is the link until the download step fills in the real one.
  const session = await createSession(db, { title: url, source: "youtube", sourceUrl: url, hint });
  if (record.ref) await linkRecord(db, session.id, record.ref);
  await sendStart(boss, session.id);
  return Response.json({ sessionId: session.id });
}
