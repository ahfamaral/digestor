import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isUuid } from "@/lib/ids";
import { errorResponse } from "@/lib/http";
import { getServer } from "@/lib/server";
import { buildSrt, buildVtt, trackToCues } from "@digestor/core";
import { getClip, getMoment, listTracks } from "@digestor/core/server";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LANG = "[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*";
type Kind = "proxy" | "frame" | "thumb" | "render" | "burned" | "subtitle";
/** Allow-list of servable files. Groups, in order: clip id (if any), track language (if any), extension. */
const ALLOWED: { re: RegExp; kind: Kind }[] = [
  { re: /^proxy\.(mp4)$/, kind: "proxy" },
  { re: /^names\/([A-Za-z0-9_-]{1,64})\.(jpg)$/, kind: "frame" },
  { re: new RegExp(`^thumbs/(${UUID})\\.(jpg)$`, "i"), kind: "thumb" },
  { re: new RegExp(`^clips/(${UUID})\\.(mp4)$`, "i"), kind: "render" },
  { re: new RegExp(`^clips/(${UUID})\\.(${LANG})\\.burned\\.(mp4)$`, "i"), kind: "burned" },
  { re: new RegExp(`^clips/(${UUID})\\.(${LANG})\\.(srt|vtt)$`, "i"), kind: "subtitle" },
];
const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
};

type Match = { file: string; kind: Kind; clipId: string | null; lang: string | null; ext: string };

/** Joins the raw (still-encoded) catch-all segments; the allow-list then validates the whole path. */
function matchFile(segments: string[]): Match | null {
  let file: string;
  try {
    file = segments.map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  for (const { re, kind } of ALLOWED) {
    const m = re.exec(file);
    if (!m) continue;
    const groups = m.slice(1) as string[];
    const ext = groups.pop()!.toLowerCase();
    const withClip = kind !== "proxy" && kind !== "frame";
    return { file, kind, clipId: withClip ? groups[0]!.toLowerCase() : null, lang: kind === "burned" || kind === "subtitle" ? groups[1]! : null, ext };
  }
  return null;
}

/** Single-range parser: `bytes=a-b`, `bytes=a-`, `bytes=-n`. Returns null when invalid or unsatisfiable. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Number(m[2]);
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** A download name from a clip title: no path or reserved characters, no control characters, bounded length. */
function safeBaseName(title: string): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100).trim();
  return cleaned === "" ? "clip" : cleaned;
}

/** RFC 5987 `filename*` plus a plain-ASCII `filename` fallback (non-ASCII replaced, quotes and backslashes dropped). */
function contentDisposition(name: string): string {
  const ascii = name.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The clip's moment title (the download name), or "clip" when the clip, its moment or its title is gone. */
async function clipTitle(clipId: string): Promise<string> {
  const { db } = getServer();
  const clip = await getClip(db, clipId);
  const moment = clip?.momentId ? await getMoment(db, clip.momentId) : null;
  return moment?.title ?? "clip";
}

/**
 * SRT / VTT are rendered from the track's cues on every request, so they are always current (no file on disk). An
 * outdated track (built for an older cut, R27) has none: its times no longer match the clip.
 */
async function subtitleResponse(sessionId: string, match: Match, download: boolean): Promise<Response> {
  const { db } = getServer();
  const clip = await getClip(db, match.clipId!);
  if (!clip || clip.sessionId !== sessionId) return errorResponse(404, "Not found.");
  const lang = match.lang!.toLowerCase();
  const track = (await listTracks(db, clip.id)).find((t) => t.language.toLowerCase() === lang);
  if (!track || track.status === "outdated" || track.cues.length === 0) return errorResponse(404, "Not found.");
  const cues = trackToCues(track.cues);
  if (cues.length === 0) return errorResponse(404, "Not found.");
  const headers = new Headers({ "Content-Type": CONTENT_TYPES[match.ext]! });
  if (download) headers.set("Content-Disposition", contentDisposition(`${safeBaseName(await clipTitle(clip.id))}.${track.language}.${match.ext}`));
  return new Response(match.ext === "srt" ? buildSrt(cues) : buildVtt(cues), { status: 200, headers });
}

/**
 * Streams bytes [start, end] of a file. Unlike `Readable.toWeb`, a cancel (the client dropped the request)
 * destroys the fs stream, closing the file, and fs events arriving after that are ignored instead of
 * throwing "Controller is already closed".
 */
function fileStream(fullPath: string, range: { start: number; end: number }): ReadableStream<Uint8Array> {
  const file = createReadStream(fullPath, range);
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      file.on("data", (chunk) => {
        if (done) return;
        controller.enqueue(chunk as Buffer);
        if ((controller.desiredSize ?? 0) <= 0) file.pause(); // backpressure: wait for pull()
      });
      file.on("end", () => {
        if (done) return;
        done = true;
        controller.close();
      });
      file.on("error", (err) => {
        if (done) return;
        done = true;
        controller.error(err);
      });
    },
    pull() {
      file.resume();
    },
    cancel() {
      done = true;
      file.destroy();
    },
  });
}

/** GET /api/files/<sessionId>/<path…>[?download=1] — streams session media with HTTP Range support. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; file: string[] }> }): Promise<Response> {
  const { id, file: segments } = await ctx.params;
  const match = matchFile(segments);
  if (!isUuid(id) || !match) return errorResponse(404, "Not found.");

  const download = new URL(req.url).searchParams.get("download") === "1";
  if (match.kind === "subtitle") return subtitleResponse(id, match, download);

  const { storage } = getServer();
  const fullPath = storage.resolve(storage.key(id, match.file));
  let size: number;
  try {
    const st = await stat(fullPath);
    if (!st.isFile()) return errorResponse(404, "Not found.");
    size = st.size;
  } catch {
    return errorResponse(404, "Not found.");
  }

  const headers = new Headers({ "Content-Type": CONTENT_TYPES[match.ext]!, "Accept-Ranges": "bytes" });
  if (download) {
    const base = match.clipId ? safeBaseName(await clipTitle(match.clipId)) : "clip";
    headers.set("Content-Disposition", contentDisposition(`${match.lang ? `${base}.${match.lang}` : base}.${match.ext}`));
  }

  const rangeHeader = req.headers.get("range");
  let status = 200;
  let range = { start: 0, end: size - 1 };
  if (rangeHeader !== null) {
    const parsed = parseRange(rangeHeader, size);
    if (!parsed) return errorResponse(416, "Range not satisfiable.", { "Content-Range": `bytes */${size}` });
    range = parsed;
    status = 206;
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  }
  headers.set("Content-Length", String(size === 0 ? 0 : range.end - range.start + 1));
  if (size === 0) return new Response(null, { status, headers });

  return new Response(fileStream(fullPath, range), { status, headers });
}
