import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Zip, ZipPassThrough } from "fflate";
import { OWNER_ID, exportChecklist, speakersInRange } from "@digestor/core";
import { getMoment, getSession, getTranscript, listAttributions, listClips, listTracks } from "@digestor/core/server";
import { exportRows } from "@/lib/exportRows";
import { errorResponse } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { asProfile } from "@/lib/preview";
import { getServer } from "@/lib/server";
import { contentDisposition, safeBaseName, subtitleText } from "@/lib/subtitleFiles";
import { isZipChoice, zipClipOf, zipEntries, type ZipChoice } from "@/lib/zipNames";

/** What goes into one zip entry: a stored file (by absolute path) or text rendered from cues. */
type Source = { name: string } & ({ path: string } | { text: string });

const SUFFIX: Record<ZipChoice, string> = { burned: "with subtitles", files: "with subtitle files", plain: "videos" };

/**
 * Streams a zip as it reads (fflate's Zip has no Zip64: archives over 4 GB are unsupported; clips are short): each file is piped in 64 KiB chunks and stored, not deflated (MP4s don't compress), so a
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

const LANGUAGE_CODE = /^[A-Za-z0-9-]+$/;

const exists = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/** Resolves what the zip would hold (stored files that exist, SRT/VTT text), or the error response. */
async function plan(id: string, choice: ZipChoice): Promise<{ sources: Source[]; title: string } | Response> {
  const { db, storage } = getServer();
  const session = await getSession(db, id);
  if (!session) return errorResponse(404, "Session not found.");

  // A video goes in only while its clip passes the export checklist, as on the Export page (`exportRows`).
  const clips = await listClips(db, OWNER_ID, id);
  const [transcript, atts] = clips.length > 0 ? await Promise.all([getTranscript(db, id), listAttributions(db, id)]) : [null, []];
  const profile = asProfile(session.profile);
  const rows = await Promise.all(
    clips.map(async (clip) => {
      const [moment, tracks] = await Promise.all([clip.momentId ? getMoment(db, clip.momentId) : null, listTracks(db, clip.id)]);
      const cleared = exportChecklist({ clip, moment, tracks, profile, speakers: speakersInRange(transcript?.words ?? [], atts, clip) }).every((i) => i.ok);
      return { clip, tracks, zip: zipClipOf({ id: clip.id, title: moment?.title ?? "", row: exportRows([{ ...clip, cleared }], tracks)[0]! }) };
    }),
  );
  const byId = new Map(rows.map((r) => [r.clip.id, r]));
  const file = (rel: string) => storage.pathOf(storage.key(id, rel));

  const sources: Source[] = [];
  for (const e of zipEntries(rows.map((r) => r.zip), choice).entries) {
    // A language code ends up in a storage path: only plain codes (en, pt-BR) are used; anything else is skipped.
    if (e.language !== undefined && !LANGUAGE_CODE.test(e.language)) {
      console.error("download: skipped a track with an unusable language code", e.clipId);
      continue;
    }
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
  return { sources, title: session.title };
}

/**
 * GET /api/sessions/[id]/download?choice=burned|files|plain — a zip of files that are already stored: `burned` the
 * subtitle videos (one per language), `files` the plain videos plus SRT/VTT rendered from the cues, `plain` the plain
 * videos. Nothing is rendered here, and a clip's videos go in only while it passes the export checklist. 409 "Nothing to download yet." when the zip would be empty. With `check=1` it runs
 * the same checks and answers `{ files }` as JSON without streaming, so the page can show a failure in its dialog
 * before starting a normal browser download. Kept clips of a session whose video was removed still download (R30).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return errorResponse(404, "Session not found.");
  const url = new URL(req.url);
  const choice = url.searchParams.get("choice");
  if (!isZipChoice(choice)) return errorResponse(400, "Choose what to download.");

  const planned = await plan(id, choice);
  if (planned instanceof Response) return planned;
  if (url.searchParams.get("check") === "1") return Response.json({ files: planned.sources.length }, { headers: { "Cache-Control": "no-store" } });

  return new Response(zipStream(planned.sources), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`${safeBaseName(planned.title)} - clips ${SUFFIX[choice]}.zip`),
      "Cache-Control": "no-store",
    },
  });
}
