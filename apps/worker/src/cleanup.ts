import type { ChromaClient } from "chromadb";
import { deleteSessionIndex } from "./search/index.js";
import { releaseReadyAudio, type AudioDeps } from "./pipeline/audio.js";
import { deletePipelineRun, getRunningAnalysis, listSessionsWithExpiredVideo, updateSession, type Db, type LocalStorage, type Stage } from "@digestor/core/server";

/** pg-boss queue for the daily video retention clean-up (scheduled 03:00 UTC in main.ts). */
export const CLEANUP_QUEUE = "maintenance.cleanup";
export const CLEANUP_CRON = "0 3 * * *";

/** Stages where a job may still be reading or writing the session's files: never deleted. */
const PROCESSING_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "downloading",
  "preparing",
  "transcribing",
  "naming_speakers",
  "understanding",
  "indexing",
  "finding_topics",
  "finding_moments",
  "writing_briefing",
  "preparing_preview",
]);

export type CleanupDeps = {
  db: Db;
  storage: Pick<LocalStorage, "removeVideoFiles">;
  /** Transcript search index; its collection goes with the video (best effort). */
  chroma?: ChromaClient;
};

/**
 * Removes the source video (`original.*`, `audio.mp3`, `proxy.mp4`) of sessions older than `days`, then their pipeline
 * run row (it holds the journalist's context answers) and search index (best effort), then sets `videoDeletedAt`. Rows, thumbnails and rendered `clips/` stay. `videoDeletedAt` goes last, so a
 * failed step leaves the session a candidate for the next run.
 */
export async function runVideoRetention(deps: CleanupDeps, days: number): Promise<{ removed: number }> {
  const expired = await listSessionsWithExpiredVideo(deps.db, days);
  let removed = 0;
  for (const session of expired) {
    if (PROCESSING_STAGES.has(session.stage) || session.stage === "awaiting_context") continue;
    try {
      if (await getRunningAnalysis(deps.db, session.id)) continue; // a re-analysis is mid-run
      await deps.storage.removeVideoFiles(session.id);
      await deletePipelineRun(deps.db, session.id);
      if (deps.chroma) {
        try {
          await deleteSessionIndex(deps.chroma, session.id);
        } catch (err) {
          console.error(`cleanup: could not delete the search index of session ${session.id}`, err);
        }
      }
      await updateSession(deps.db, session.id, { videoDeletedAt: new Date() });
      removed++;
    } catch (err) {
      console.error(`cleanup: could not remove the video of session ${session.id}`, err);
    }
  }
  return { removed };
}

/** VIDEO_RETENTION_DAYS from the environment (default 14); invalid or non-positive values fall back to the default. */
export function videoRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.VIDEO_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

export type DailyCleanupDeps = CleanupDeps & { storage: CleanupDeps["storage"] & AudioDeps["storage"] };

/**
 * The daily `maintenance.cleanup` job: releases leftover `audio.mp3` of ready sessions, then the video retention. Each
 * part runs even when the other failed (a DB error in one never skips the other); a failure is rethrown afterwards so
 * the job shows as failed (both parts are safe to repeat).
 */
export async function runDailyCleanup(
  deps: DailyCleanupDeps,
  days: number,
  parts = { releaseReadyAudio, runVideoRetention },
): Promise<{ released: number; removed: number }> {
  const failures: unknown[] = [];
  let released = 0;
  let removed = 0;
  try {
    released = (await parts.releaseReadyAudio(deps)).released;
    if (released > 0) console.log(`cleanup: released audio.mp3 of ${released} ready session(s)`);
  } catch (err) {
    console.error("cleanup: could not release the audio of ready sessions", err);
    failures.push(err);
  }
  try {
    removed = (await parts.runVideoRetention(deps, days)).removed;
    console.log(`cleanup: removed the video of ${removed} session(s) older than ${days} day(s)`);
  } catch (err) {
    console.error("cleanup: the video retention failed", err);
    failures.push(err);
  }
  if (failures.length > 0) throw new AggregateError(failures, "maintenance.cleanup: a part failed (see the log)");
  return { released, removed };
}
