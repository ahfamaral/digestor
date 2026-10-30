import { writeFile } from "node:fs/promises";
import type { TrackCue } from "@digestor/core";
import {
  getClip, getSession, getTrack, getTranscript, setTrackCues, setTrackFiles, type Db, type LocalStorage,
} from "@digestor/core/server";
import { translateCues } from "../agents/translate.js";
import type { StructuredLLM } from "../llm/structured.js";
import { buildCues, buildSrt, buildVtt, type Cue } from "../media/subtitles.js";

export type TrackDeps = { db: Db; storage: LocalStorage; llm: StructuredLLM };

/**
 * Builds a track's cues from the clip's words (translating when the language differs from the session's), stores them
 * and writes the .srt/.vtt files. Throws on failure: the job handler decides between retry and marking it failed.
 * Idempotent: a retry rebuilds the same rows and files.
 */
export async function prepareTrack(deps: TrackDeps, trackId: string): Promise<void> {
  const { db, storage, llm } = deps;
  const track = await getTrack(db, trackId);
  if (!track) {
    console.log(`Ignoring track ${trackId}: not found`);
    return;
  }
  const clip = await getClip(db, track.clipId);
  if (!clip || clip.deletedAt) {
    console.log(`Ignoring track ${trackId}: its clip is gone`);
    return;
  }
  const [session, transcript] = await Promise.all([getSession(db, clip.sessionId), getTranscript(db, clip.sessionId)]);
  if (!session || !transcript) throw new Error(`Track ${trackId}: session ${clip.sessionId} has no transcript`);

  const base = buildCues(transcript.words, clip);
  const original = base.map((c) => c.lines.join(" "));
  const sourceLang = session.language ?? transcript.language;
  const texts =
    track.language === sourceLang
      ? original.map((text) => ({ text, missing: false }))
      : await translateCues(llm, { from: sourceLang, to: track.language, lines: original });

  const cues: TrackCue[] = base.map((c, i) => ({
    startMs: c.startMs, endMs: c.endMs, original: original[i]!, text: texts[i]!.text, missing: texts[i]!.missing,
  }));
  // Files show the track text; a gap is skipped rather than written as an empty cue.
  const shown: Cue[] = [];
  base.forEach((c, i) => {
    if (cues[i]!.text) shown.push({ startMs: c.startMs, endMs: c.endMs, lines: track.language === sourceLang ? c.lines : [cues[i]!.text] });
  });

  const srtKey = storage.key(clip.sessionId, `clips/${clip.id}.${track.language}.srt`);
  const vttKey = storage.key(clip.sessionId, `clips/${clip.id}.${track.language}.vtt`);
  await writeFile(storage.resolve(srtKey), buildSrt(shown));
  await writeFile(storage.resolve(vttKey), buildVtt(shown));
  await setTrackCues(db, trackId, cues, "ready");
  await setTrackFiles(db, trackId, { srtKey, vttKey });
}
