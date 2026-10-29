import { deleteSession, listExpiredSessions, type Db, type LocalStorage, type Stage } from "@digestor/core/server";

/** pg-boss queue for the daily retention clean-up (scheduled 03:00 UTC in main.ts). */
export const CLEANUP_QUEUE = "maintenance.cleanup";
export const CLEANUP_CRON = "0 3 * * *";

/** Stages where a job may still be reading or writing the session's files: never deleted. */
const PROCESSING_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "downloading",
  "preparing",
  "transcribing",
  "understanding",
  "finding_clips",
  "rendering",
]);

export type CleanupDeps = { db: Db; storage: Pick<LocalStorage, "removeSession"> };

/**
 * Deletes sessions older than `retentionDays` (DB rows cascade to transcripts, cards, clips) and their data folder.
 * Files go first, so a failed removal leaves the row in place and the next run retries it.
 */
export async function runCleanup(deps: CleanupDeps, retentionDays: number): Promise<{ deleted: number }> {
  const expired = await listExpiredSessions(deps.db, retentionDays);
  let deleted = 0;
  for (const session of expired) {
    if (PROCESSING_STAGES.has(session.stage)) continue;
    try {
      await deps.storage.removeSession(session.id);
      await deleteSession(deps.db, session.id);
      deleted++;
    } catch (err) {
      console.error(`cleanup: could not delete session ${session.id}`, err);
    }
  }
  return { deleted };
}

/** RETENTION_DAYS from the environment (default 7); invalid or non-positive values fall back to the default. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}
