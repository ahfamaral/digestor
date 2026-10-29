import { writeFile, rm } from "node:fs/promises";
import { sliceWords } from "@digestor/core";
import { finishClipRender, getClip, getSession, getTranscript, setRenderState } from "@digestor/core/server";
import { buildAss, buildCues, buildSrt } from "../media/subtitles.js";
import type { PipelineDeps } from "./graph.js";

/**
 * Render one clip with burned-in subtitles from the original video, plus a sidecar .srt.
 * renderStatus goes queued → rendering → done (or stale if the clip changed during the render);
 * on any error it becomes failed and the error is rethrown.
 */
export async function renderOne(deps: PipelineDeps, clipId: string): Promise<void> {
  const { db, storage, media } = deps;
  const clip = await getClip(db, clipId);
  if (!clip) throw new Error(`Clip not found: ${clipId}`);
  await setRenderState(db, clipId, { renderStatus: "queued" });

  const assPath = storage.resolve(storage.key(clip.sessionId, `clips/${clipId}.ass`));
  try {
    const [session, transcript] = await Promise.all([getSession(db, clip.sessionId), getTranscript(db, clip.sessionId)]);
    if (!session?.originalKey) throw new Error(`Session ${clip.sessionId} has no original video`);
    if (!transcript) throw new Error(`Session ${clip.sessionId} has no transcript`);
    await setRenderState(db, clipId, { renderStatus: "rendering" });

    const original = storage.resolve(session.originalKey);
    const range = { startMs: clip.startMs, endMs: clip.endMs };
    const cues = buildCues(sliceWords(transcript.words, range), range);
    const { width, height } = await media.probe(original);
    await writeFile(assPath, buildAss(cues, { width, height }), "utf8");

    const renderKey = storage.key(clip.sessionId, `clips/${clipId}.mp4`);
    const srtKey = storage.key(clip.sessionId, `clips/${clipId}.srt`);
    await media.renderClip({ input: original, output: storage.resolve(renderKey), ...range, assPath });
    await writeFile(storage.resolve(srtKey), buildSrt(cues), "utf8");
    // The user may have edited the times or un-approved the clip while ffmpeg ran: then this file is stale.
    // One conditional UPDATE decides, so no edit can slip in between a check and the write.
    await finishClipRender(db, clipId, range, { renderKey, srtKey });
  } catch (err) {
    await setRenderState(db, clipId, { renderStatus: "failed" });
    throw err;
  } finally {
    await rm(assPath, { force: true });
  }
}
