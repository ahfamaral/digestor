/**
 * One-off backfill: subtitle tracks made before 2026-11-23 have no word times on their lines, so a long line splits
 * by characters and can't highlight words. For every `ready` track this rebuilds the lines from the transcript for the
 * range the track was built for and adds each matching line's words (same start and end). Text, approval and burned
 * videos are not touched; lines that already have words are skipped, so running it twice is safe.
 *
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/backfill-track-words.ts [--dry]
 *
 * It runs in the worker container (which has the database URL) and never calls an LLM.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { attachTrackWords, attachWords, clips, createDb, getTranscript, subtitleTracks } from "@digestor/core/server";
import { buildCues } from "../src/media/subtitles.js";

const dry = process.argv.includes("--dry");
const { db, close } = createDb(process.env.DATABASE_URL!);
try {
  const rows = await db
    .select({ track: subtitleTracks, sessionId: clips.sessionId })
    .from(subtitleTracks)
    .innerJoin(clips, eq(clips.id, subtitleTracks.clipId))
    .where(and(eq(subtitleTracks.status, "ready"), isNotNull(subtitleTracks.builtStartMs), isNotNull(subtitleTracks.builtEndMs)));
  const transcripts = new Map<string, Awaited<ReturnType<typeof getTranscript>>>();
  let tracks = 0;
  let lines = 0;
  let attached = 0;
  for (const { track, sessionId } of rows) {
    if (track.cues.every((c) => c.words?.length)) continue;
    if (!transcripts.has(sessionId)) transcripts.set(sessionId, await getTranscript(db, sessionId));
    const transcript = transcripts.get(sessionId);
    if (!transcript) continue;
    const built = buildCues(transcript.words, { startMs: track.builtStartMs!, endMs: track.builtEndMs! });
    const result = dry ? { ...attachWords(track.cues, built), lines: track.cues.length } : await attachTrackWords(db, track.id, built);
    if (!result) continue;
    tracks++;
    lines += result.lines;
    attached += result.attached;
    console.log(`track ${track.id} (${track.language}): ${result.attached} of ${result.lines} lines`);
  }
  console.log(`${dry ? "Would add" : "Added"} word times to ${attached} of ${lines} lines in ${tracks} track(s).`);
} finally {
  await close();
}
