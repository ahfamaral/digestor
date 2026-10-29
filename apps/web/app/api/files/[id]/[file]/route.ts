import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getClip } from "@digestor/core/server";
import { isUuid } from "@/lib/ids";
import { errorResponse } from "@/lib/http";
import { getServer } from "@/lib/server";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Allow-list of servable files; group 1 = clip id (if any), group 2 = extension. */
const ALLOWED = [
  /^proxy\.(mp4)$/,
  new RegExp(`^thumbs/(${UUID})\\.(jpg)$`, "i"),
  new RegExp(`^clips/(${UUID})\\.(mp4|srt)$`, "i"),
];
const CONTENT_TYPES: Record<string, string> = { mp4: "video/mp4", jpg: "image/jpeg", srt: "application/x-subrip" };

function matchFile(raw: string): { file: string; clipId: string | null; ext: string } | null {
  let file: string;
  try {
    file = decodeURIComponent(raw); // `thumbs/<id>.jpg` arrives as one segment, `thumbs%2F<id>.jpg`
  } catch {
    return null;
  }
  for (const re of ALLOWED) {
    const m = re.exec(file);
    if (m) return m.length === 3 ? { file, clipId: m[1]!, ext: m[2]!.toLowerCase() } : { file, clipId: null, ext: m[1]! };
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

async function attachmentName(clipId: string | null, sessionId: string): Promise<string> {
  const clip = clipId ? await getClip(getServer().db, clipId) : null;
  const title = clip?.sessionId === sessionId ? clip.title.replace(/[^\w\- ]/g, "").trim() : "";
  return title || "clip";
}

/** GET /api/files/<sessionId>/<file>[?download=1] — streams session media with HTTP Range support. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; file: string }> }): Promise<Response> {
  const { id, file: rawFile } = await ctx.params;
  const match = matchFile(rawFile);
  if (!isUuid(id) || !match) return errorResponse(404, "Not found.");

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
  if (new URL(req.url).searchParams.get("download") === "1") {
    const name = await attachmentName(match.clipId, id);
    headers.set("Content-Disposition", `attachment; filename="${name}.${match.ext}"`);
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

  const stream = createReadStream(fullPath, { start: range.start, end: range.end });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
}
