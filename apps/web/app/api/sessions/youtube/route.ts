import { z } from "zod";
import { InvalidYouTubeUrlError, parseYouTubeUrl } from "@digestor/core";
import { createSession, deleteSession, linkRecord } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { readLanguageInput, START_FAILED } from "@/lib/languageInput";
import { readRecordInput } from "@/lib/recordInput";
import { readHintInput } from "@/lib/hintInput";
import { readGoalInput } from "@/lib/goalInput";
import { sendStart } from "@/lib/jobs";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ url: z.string(), hint: z.string().optional(), goal: z.string().optional(), record: z.string().optional(), chamber: z.unknown().optional(), language: z.unknown().optional() });

/** POST /api/sessions/youtube { url, hint?, goal?, record?, chamber?, language? } — the worker downloads the video. */
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

  const record = readRecordInput(parsed.data.record, parsed.data.chamber);
  if ("error" in record) return record.error;

  const language = readLanguageInput(parsed.data.language);
  if ("error" in language) return language.error;
  const note = readHintInput(parsed.data.hint);
  if ("error" in note) return note.error;
  const goalInput = readGoalInput(parsed.data.goal);
  if ("error" in goalInput) return goalInput.error;

  const { db, boss } = getServer();
  const hint = note.hint;
  // The title is the link until the download step fills in the real one.
  let sessionId: string | null = null;
  try {
    const session = await createSession(db, { title: url, source: "youtube", sourceUrl: url, hint, goal: goalInput.goal, languageOverride: language.code });
    sessionId = session.id;
    // The session row has to exist before its record can be linked (foreign key), so a link failure can't stop the session
    // from starting: log it and go on. The record stays optional: it can be linked from Who's who at any time.
    if (record.ref) {
      try {
        await linkRecord(db, session.id, record.ref);
      } catch (err) {
        console.error("upload: linking the record failed", err);
      }
    }
    await sendStart(boss, session.id);
  } catch (err) {
    console.error("youtube: starting the session failed", err);
    if (sessionId) await deleteSession(db, sessionId).catch((e) => console.error("youtube: removing the session row failed", e));
    return errorResponse(503, START_FAILED);
  }
  return Response.json({ sessionId });
}
