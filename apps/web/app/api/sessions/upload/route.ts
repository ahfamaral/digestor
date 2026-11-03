import { randomUUID } from "node:crypto";
import { AUDIO_ONLY_WARNING, UPLOAD_UNSUPPORTED, isAudioExtension, isUploadExtension } from "@digestor/core";
import { createSession, linkRecord, UploadTooLargeError } from "@digestor/core/server";
import { authCookieFrom, isAuthorized } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { readRecordInput } from "@/lib/recordInput";
import { sendStart } from "@/lib/jobs";
import { getServer } from "@/lib/server";

function maxUploadGb(): number {
  const n = Number(process.env.MAX_UPLOAD_GB);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * PUT /api/sessions/upload?filename=<name>&hint=<text>[&record=<date or link>][&audioOnlyAck=1] — body is the raw file stream.
 * Audio files (mp3, m4a, wav) need `audioOnlyAck=1`: clips from them show a waveform, and the user must accept that.
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
  const record = readRecordInput(params.get("record"));
  if ("error" in record) return record.error;
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

  const hint = params.get("hint")?.trim() || null;
  await createSession(db, { id: sessionId, title: filename.slice(0, dot), source: "upload", originalKey, hint, audioOnlyAck: audioOnly });
  if (record.ref) await linkRecord(db, sessionId, record.ref);
  await sendStart(boss, sessionId);
  return Response.json({ sessionId });
}
