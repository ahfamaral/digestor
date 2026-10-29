import { randomUUID } from "node:crypto";
import { createSession, UploadTooLargeError } from "@digestor/core/server";
import { authCookieFrom, isAuthorized } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { sendStart } from "@/lib/jobs";
import { getServer } from "@/lib/server";

const EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm"]);
const UNSUPPORTED = "Unsupported file type. Use MP4, MOV, MKV or WebM.";

function maxUploadGb(): number {
  const n = Number(process.env.MAX_UPLOAD_GB);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** PUT /api/sessions/upload?filename=<name>&hint=<text> — body is the raw file stream. */
export async function PUT(req: Request): Promise<Response> {
  // Excluded from middleware.ts (Next would buffer the body), so the gate is checked here.
  if (!(await isAuthorized(authCookieFrom(req)))) return errorResponse(401, "Unauthorized.");

  const params = new URL(req.url).searchParams;
  const filename = (params.get("filename") ?? "").split(/[\\/]/).pop()!.trim();
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (!EXTENSIONS.has(ext)) return errorResponse(400, UNSUPPORTED);
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
  await createSession(db, { id: sessionId, title: filename.slice(0, dot), source: "upload", originalKey, hint });
  await sendStart(boss, sessionId);
  return Response.json({ sessionId });
}
