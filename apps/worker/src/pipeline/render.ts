import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackToCues } from "@digestor/core";
import {
  burnSignature, finishClipRender, finishTrackBurn, getClip, getSession, getTrack, setClipRenderStatus, setTrackBurnStatus,
  type Db, type LocalStorage,
} from "@digestor/core/server";
import { VideoRemovedError } from "../errors.js";
import { probe, renderClip as ffmpegRenderClip, renderSize, type RenderClipOptions } from "../media/ffmpeg.js";
import { buildAss } from "../media/subtitles.js";

export type RenderDeps = {
  db: Db;
  storage: LocalStorage;
  /** Injectable for tests; defaults to the real ffmpeg render. */
  renderClip?: (o: RenderClipOptions) => Promise<void>;
};

type Clip = NonNullable<Awaited<ReturnType<typeof getClip>>>;

/** The original file to cut from; throws VideoRemovedError when retention already deleted it. */
async function sourceOf(deps: RenderDeps, clip: Clip) {
  const session = await getSession(deps.db, clip.sessionId);
  if (!session) return null;
  if (session.videoDeletedAt || !session.originalKey) throw new VideoRemovedError();
  return { session, input: deps.storage.resolve(session.originalKey) };
}

/** Cuts the clip (no subtitles) to `clips/<clipId>.mp4`. The sender claimed it (`queued`); `done` only if nothing changed meanwhile. */
export async function renderClipJob(deps: RenderDeps, clipId: string): Promise<void> {
  const clip = await getClip(deps.db, clipId);
  if (!clip || clip.deletedAt) {
    console.log(`Ignoring render of clip ${clipId}: gone`);
    return;
  }
  if (clip.renderStatus !== "queued" && clip.renderStatus !== "rendering") {
    console.log(`Ignoring render of clip ${clipId}: it is ${clip.renderStatus}, not waiting for a render`);
    return;
  }
  const src = await sourceOf(deps, clip);
  if (!src) return;
  const range = { startMs: clip.startMs, endMs: clip.endMs, format: clip.format, cropOffset: clip.cropOffset, credit: clip.credit };
  await setClipRenderStatus(deps.db, clipId, "rendering");
  const key = deps.storage.key(clip.sessionId, `clips/${clip.id}.mp4`);
  await (deps.renderClip ?? ffmpegRenderClip)({
    input: src.input, output: deps.storage.resolve(key), ...range, hasVideo: src.session.hasVideo,
  });
  await finishClipRender(deps.db, clipId, range, { renderKey: key });
}

/** Burns an approved track's translated text into `clips/<clipId>.<lang>.burned.mp4`. */
export async function burnTrack(deps: RenderDeps, trackId: string): Promise<void> {
  const track = await getTrack(deps.db, trackId);
  const clip = track && (await getClip(deps.db, track.clipId));
  if (!track || !clip || clip.deletedAt) {
    console.log(`Ignoring burn of track ${trackId}: gone`);
    return;
  }
  if (track.burnStatus !== "queued" && track.burnStatus !== "rendering") {
    console.log(`Ignoring burn of track ${trackId}: it is ${track.burnStatus}, not waiting for a burn`);
    return;
  }
  const src = await sourceOf(deps, clip);
  if (!src) return;
  // The signature is taken from the rows we render with; finishTrackBurn compares it with the rows at the end.
  const signature = burnSignature(track, clip);
  await setTrackBurnStatus(deps.db, trackId, "rendering");
  const hasVideo = src.session.hasVideo;
  const size = renderSize(clip.format, hasVideo ? await probe(src.input) : { hasVideo: false, width: 0, height: 0 });
  const key = deps.storage.key(clip.sessionId, `clips/${clip.id}.${track.language}.burned.mp4`);
  const tmp = await mkdtemp(join(tmpdir(), "digestor-burn-"));
  try {
    const assPath = join(tmp, "subs.ass");
    await writeFile(assPath, buildAss(trackToCues(track.cues, clip.format), size, { style: clip.subtitleStyle, position: clip.subtitlePosition, format: clip.format }), "utf8");
    await (deps.renderClip ?? ffmpegRenderClip)({
      input: src.input, output: deps.storage.resolve(key), startMs: clip.startMs, endMs: clip.endMs, format: clip.format,
      cropOffset: clip.cropOffset, credit: clip.credit, hasVideo, assPath,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  await finishTrackBurn(deps.db, trackId, signature, key);
}
