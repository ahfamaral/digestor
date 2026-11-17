import { z } from "zod";
import { createSession, deleteSession, linkRecord, speechClipSource } from "@digestor/core/server";
import { errorResponse } from "@/lib/http";
import { START_FAILED } from "@/lib/languageInput";
import { sendStart } from "@/lib/jobs";
import { MAX_CLIP_S, clipSection, monitorClipEnabled, speakerLabel } from "@/lib/monitor/clip";
import { MONITOR_LANG_COOKIE, monitorLocale, tm } from "@/lib/monitor/i18n";
import { readRecordInput } from "@/lib/recordInput";
import { getServer } from "@/lib/server";

const BodySchema = z.object({ speechKey: z.string().trim().min(1).max(200) });

/** A cookie's value; one that isn't valid percent-encoding (a tampered cookie) reads as absent, never a 500. */
function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * POST /api/monitor/clip { speechKey } → { sessionId }: one speech's moment in the plenary's official video opened as a
 * YouTube session that downloads only that part (± 20 s), in Portuguese, with the speaker in the hint and the plenary
 * linked as the official record; the profile is left to the context check. Off unless `MONITOR_CLIP_ENABLED=true`;
 * a part over 60 minutes is refused (422).
 */
export async function POST(req: Request): Promise<Response> {
  const locale = monitorLocale(cookieValue(req, MONITOR_LANG_COOKIE), req.headers.get("accept-language"));
  if (!monitorClipEnabled()) return errorResponse(403, tm(locale, "clip.disabled"));
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, tm(locale, "clip.noSpeech"));

  const { db, boss } = getServer();
  const src = await speechClipSource(db, parsed.data.speechKey);
  if (!src) return errorResponse(404, tm(locale, "clip.noVideo"));

  const section = clipSection(src, src.durationS);
  if (section.endS - section.startS > MAX_CLIP_S) return errorResponse(422, tm(locale, "clip.tooLong"));
  const url = `https://www.youtube.com/watch?v=${src.videoId}`;
  const day = src.startsAt.slice(0, 10);
  const who = speakerLabel(src.name, src.party, src.uf);
  // The plenary as the official record: the record input's own Câmara event link, so it is matched like a typed one.
  const record = readRecordInput(`https://www.camara.leg.br/evento-legislativo/${src.eventId}`, "camara");

  let sessionId: string | null = null;
  try {
    const session = await createSession(db, {
      title: `${who}, Câmara plenary, ${day}`,
      source: "youtube",
      sourceUrl: url,
      hint: `Câmara dos Deputados plenary: speech by ${who} on ${day}`,
      languageOverride: "pt",
      sourceRange: { startMs: section.startS * 1000, endMs: section.endS * 1000 },
    });
    sessionId = session.id;
    // As at upload: the row must exist before its record (foreign key); a failed link never stops the session.
    if ("ref" in record && record.ref) {
      try {
        await linkRecord(db, session.id, record.ref);
      } catch (err) {
        console.error("monitor clip: linking the record failed", err);
      }
    }
    await sendStart(boss, session.id);
  } catch (err) {
    console.error("monitor clip: starting the session failed", err);
    if (sessionId) await deleteSession(db, sessionId).catch((e) => console.error("monitor clip: removing the session row failed", e));
    return errorResponse(503, START_FAILED);
  }
  return Response.json({ sessionId });
}
