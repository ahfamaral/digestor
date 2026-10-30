import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { getRunningAnalysis, listSessionsWithExpiredVideo, updateSession, type Db, type LocalStorage, type Stage } from "@digestor/core/server";

/** pg-boss queue for the daily video retention clean-up (scheduled 03:00 UTC in main.ts). */
export const CLEANUP_QUEUE = "maintenance.cleanup";
export const CLEANUP_CRON = "0 3 * * *";

/** Stages where a job may still be reading or writing the session's files: never deleted. */
const PROCESSING_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "downloading",
  "preparing",
  "transcribing",
  "understanding",
  "indexing",
  "finding_topics",
  "finding_moments",
  "writing_briefing",
]);

export type CleanupDeps = {
  db: Db;
  storage: Pick<LocalStorage, "removeVideoFiles">;
  /** The pipeline's LangGraph checkpointer: thread id = session id; its checkpoints hold the human's answers. */
  checkpointer: Pick<BaseCheckpointSaver, "deleteThread">;
};

/**
 * Removes the source video (`original.*`, `audio.mp3`, `proxy.mp4`) of sessions older than `days`, then their LangGraph
 * checkpoints, then sets `videoDeletedAt`. Rows, thumbnails and rendered `clips/` stay. `videoDeletedAt` goes last, so a
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
      await deps.checkpointer.deleteThread(session.id);
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
