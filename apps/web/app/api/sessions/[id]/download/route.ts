import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Zip, ZipPassThrough } from "fflate";
import { OWNER_ID } from "@digestor/core";
import { getMoment, getSession, listClips, listTracks } from "@digestor/core/server";
import { exportRows } from "@/lib/exportRows";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { getServer } from "@/lib/server";
import { contentDisposition, safeBaseName, subtitleText } from "@/lib/subtitleFiles";
import { isZipChoice, zipClipOf, zipEntries, type ZipChoice } from "@/lib/zipNames";

/** What goes into one zip entry: a stored file (by absolute path) or text rendered from cues. */
type Source = { name: string } & ({ path: string } | { text: string });

const SUFFIX: Record<ZipChoice, string> = { burned: "with subtitles", files: "with subtitle files", plain: "videos" };

/**
 * Streams a zip as it reads: each file is piped in 64 KiB chunks and stored, not deflated (MP4s don't compress), so a
 * large clip is never held whole in memory. A client that drops the request cancels the read and closes the file.
 */
function zipStream(sources: Source[]): ReadableStream<Uint8Array> {
  let cancelled = false;
  let wake: (() => void) | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const zip = new Zip((err, chunk, final) => {
        if (cancelled) return;
        if (err) return controller.error(err);
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      const room = async () => {
        while (!cancelled && (controller.desiredSize ?? 1) <= 0) await new Promise<void>((resolve) => (wake = resolve));
      };
      void (async () => {
        try {
          for (const source of sources) {
            if (cancelled) return;
            const file = new ZipPassThrough(source.name);
            zip.add(file);
            if ("text" in source) {
              file.push(new TextEncoder().encode(source.text), true);
              continue;
            }
            const read = createReadStream(source.path, { highWaterMark: 64 * 1024 });
            try {
              let held: Uint8Array | null = null;
              for await (const chunk of read) {
                if (cancelled) return;
                if (held) file.push(held);
                held = chunk as Uint8Array;
                await room();
              }
              file.push(held ?? new Uint8Array(0), true);
            } finally {
              read.destroy();
            }
          }
          if (!cancelled) zip.end();
        } catch (err) {
          console.error("download: zip failed", err);
          if (!cancelled) controller.error(err);
        }
      })();
    },
    pull() {
      wake?.();
      wake = null;
    },
    cancel() {
      cancelled = true;
      wake?.();
    },
  });
}

const exists = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/**
 * GET /api/sessions/[id]/download?choice=burned|files|plain — a zip of files that are already stored: `burned` the
 * subtitle videos (one per language), `files` the plain videos plus SRT/VTT rendered from the cues, `plain` the plain
 * videos. Nothing is rendered here. 409 "Nothing to download yet." when the zip would be empty. Kept clips of a
 * session whose video was removed still download (R30).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const choice = new URL(req.url).searchParams.get("choice");
  if (!isZipChoice(choice)) return errorResponse(400, "Choose what to download.");

  const { db, storage } = getServer();
  const session = await getSession(db, id);
  if (!session) return errorResponse(404, "Session not found.");

  const rows = await Promise.all(
    (await listClips(db, OWNER_ID, id)).map(async (clip) => {
      const [moment, tracks] = await Promise.all([clip.momentId ? getMoment(db, clip.momentId) : null, listTracks(db, clip.id)]);
      return { clip, tracks, zip: zipClipOf({ id: clip.id, title: moment?.title ?? "", row: exportRows([clip], tracks)[0]! }) };
    }),
  );
  const byId = new Map(rows.map((r) => [r.clip.id, r]));
  const file = (rel: string) => storage.resolve(storage.key(id, rel));

  const sources: Source[] = [];
  for (const e of zipEntries(rows.map((r) => r.zip), choice).entries) {
    const row = byId.get(e.clipId)!;
    if (e.kind === "mp4" || e.kind === "burned") {
      const rel = e.kind === "mp4" ? `clips/${e.clipId}.mp4` : `clips/${e.clipId}.${e.language}.burned.mp4`;
      if (await exists(file(rel))) sources.push({ name: e.name, path: file(rel) });
    } else {
      const track = row.tracks.find((t) => t.language === e.language);
      const text = track ? subtitleText(track, row.clip, e.kind) : null;
      if (text !== null) sources.push({ name: e.name, text });
    }
  }
  if (sources.length === 0) return errorResponse(409, "Nothing to download yet.");

  return new Response(zipStream(sources), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`${safeBaseName(session.title)} - clips ${SUFFIX[choice]}.zip`),
      "Cache-Control": "no-store",
    },
  });
}
