import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { AUDIO_ONLY_WARNING, UPLOAD_UNSUPPORTED, isAudioExtension, isUploadExtension } from "@digestor/core";
import { createSession, deleteSession, linkRecord, UploadTooLargeError } from "@digestor/core/server";
import { authCookieFrom, isAuthorized } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { readLanguageInput, START_FAILED } from "@/lib/languageInput";
import { readRecordInput } from "@/lib/recordInput";
import { readHintInput } from "@/lib/hintInput";
import { sendStart } from "@/lib/jobs";
import { getServer } from "@/lib/server";

function maxUploadGb(): number {
  const n = Number(process.env.MAX_UPLOAD_GB);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * PUT /api/sessions/upload?filename=<name>&hint=<text>[&language=<pt|en|es|fr|de|it>][&record=<date, sitting number or link>][&chamber=<house>][&audioOnlyAck=1] — body is the raw file stream.
 * Audio files (mp3, m4a, wav) need `audioOnlyAck=1`: clips from them show a waveform, and the user must accept that.
 * A video file without a picture (audio in an .mp4/.mov) isn't refused: the worker goes on as audio-only and the
 * Processing and context screens show the same notice (`foundNoVideo`).
 */
export async function PUT(req: Request): Promise<Response> {
  // Excluded from middleware.ts (Next would buffer the body), so the gate is checked here.
  if (!(await isAuthorized(authCookieFrom(req)))) return errorResponse(401, "Unauthorized.");

  const params = new URL(req.url).searchParams;
  const filename = (params.get("filename") ?? "").split(/[\\/]/).pop()!.trim();
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (!isUploadExtension(ext)) return errorResponse(400, UPLOAD_UNSUPPORTED);
  const audioOnly = isAudioExtension(ext);
  const audioOnlyAck = params.get("audioOnlyAck") === "1";
  if (audioOnly && !audioOnlyAck) return errorResponse(400, AUDIO_ONLY_WARNING);
  const record = readRecordInput(params.get("record"), params.get("chamber"));
  if ("error" in record) return record.error;
  const language = readLanguageInput(params.get("language"));
  if ("error" in language) return language.error;
  const note = readHintInput(params.get("hint"));
  if ("error" in note) return note.error;
  if (!req.body) return errorResponse(400, "No file was uploaded.");

  const gb = maxUploadGb();
  const maxBytes = Math.floor(gb * 1024 ** 3);
  const tooLarge = `This file is larger than the ${gb} GB limit.`;
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return errorResponse(413, tooLarge);

  const { db, storage, boss } = getServer();
  const sessionId = randomUUID();
  let originalKey: string;
  try {
    originalKey = await storage.saveStream(sessionId, `original.${ext}`, req.body, maxBytes);
  } catch (err) {
    await storage.removeSession(sessionId);
    if (err instanceof UploadTooLargeError) return errorResponse(413, tooLarge);
    throw err;
  }
  if ((await stat(storage.resolve(originalKey))).size === 0) {
    await storage.removeSession(sessionId);
    return errorResponse(400, "That file is empty.");
  }

  const hint = note.hint;
  try {
    await createSession(db, { id: sessionId, title: filename.slice(0, dot), source: "upload", originalKey, hint, audioOnlyAck: audioOnly, languageOverride: language.code });
    // The session row has to exist before its record can be linked (foreign key), so a link failure can't stop the session
    // from starting: log it and go on. The record stays optional: it can be linked from Who's who at any time.
    if (record.ref) {
      try {
        await linkRecord(db, sessionId, record.ref);
      } catch (err) {
        console.error("upload: linking the record failed", err);
      }
    }
    await sendStart(boss, sessionId);
  } catch (err) {
    // Nothing is left behind: the row (cascades to its record link) and the saved file go.
    console.error("upload: starting the session failed", err);
    await deleteSession(db, sessionId).catch((e) => console.error("upload: removing the session row failed", e));
    await storage.removeSession(sessionId).catch((e) => console.error("upload: removing the session files failed", e));
    return errorResponse(503, START_FAILED);
  }
  return Response.json({ sessionId });
}
