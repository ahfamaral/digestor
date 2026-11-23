import type { TrackCue } from "@digestor/core";
import {
  failTrack, getClip, getSession, getTrack, getTranscript, setTrackCues, type Db,
} from "@digestor/core/server";
import { translateCues } from "../agents/translate.js";
import type { StructuredLLM } from "../llm/structured.js";
import { buildCues } from "../media/subtitles.js";

export type TrackDeps = { db: Db; llm: StructuredLLM };

/**
 * Builds a track's cues from the clip's words (translating when the language differs from the session's), stores them
 (SRT/VTT are rendered from the cues on download, so edits always show). Does nothing unless the
 * track is still `preparing`, so a duplicate job never wipes edits. The clip range the cues were built for is stored
 * with them. Throws on failure: the job handler decides between retry and marking it failed.
 * Idempotent: a retry rebuilds the same rows.
 */
export async function prepareTrack(deps: TrackDeps, trackId: string): Promise<void> {
  const { db, llm } = deps;
  const track = await getTrack(db, trackId);
  if (!track) {
    console.log(`Ignoring track ${trackId}: not found`);
    return;
  }
  if (track.status !== "preparing") {
    console.log(`Ignoring track ${trackId}: already ${track.status}`);
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
  if (base.length === 0) {
    await failTrack(db, trackId, "This clip has no speech to subtitle.");
    return;
  }
  const original = base.map((c) => c.lines.join(" "));
  const sourceLang = session.language ?? transcript.language;
  const texts =
    track.language === sourceLang
      ? original.map((text) => ({ text, missing: false }))
      : await translateCues(llm, { from: sourceLang, to: track.language, lines: original });

  const cues: TrackCue[] = base.map((c, i) => ({
    startMs: c.startMs, endMs: c.endMs, original: original[i]!, text: texts[i]!.text, missing: texts[i]!.missing, words: c.words,
  }));
  // Cues are clip-relative: record the cut they were built for, so a later trim marks them outdated (R27). A trim
  // that landed while this ran makes them outdated at once.
  await setTrackCues(db, trackId, cues, "ready", { startMs: clip.startMs, endMs: clip.endMs });
}
