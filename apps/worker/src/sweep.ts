import { sql } from "drizzle-orm";
import { QUEUES } from "@digestor/core";
import { failAnalysisVersion, getRunningAnalysis, type Db } from "@digestor/core/server";

/** pg-boss queue for the stale-session sweep (scheduled every 15 minutes in main.ts). */
export const SWEEP_QUEUE = "session.sweep";
export const SWEEP_CRON = "*/15 * * * *";

export const SWEEP_MESSAGE = "Processing stopped unexpectedly. Please start over.";

/** Stages where a worker job is expected to be running (`awaiting_context` is a human pause, not one of them). */
const IN_PROGRESS = [
  "downloading",
  "preparing",
  "transcribing",
  "understanding",
  "indexing",
  "finding_topics",
  "finding_moments",
  "writing_briefing",
];

const LIVE_JOB_QUEUES = [QUEUES.start, QUEUES.resume, QUEUES.reanalyze];

/** SQL: a pg-boss job that may still run for the session whose id is `idCol`. */
const hasLiveJob = (idCol: ReturnType<typeof sql.raw>) => sql`exists (
  select 1 from pgboss.job j
  where j.name in (${sql.join(LIVE_JOB_QUEUES.map((q) => sql`${q}`), sql`, `)})
    and j.state in ('created', 'retry', 'active')
    and j.data->>'sessionId' = ${idCol}::text
)`;

/**
 * Closes the gap where a job dies on its last attempt without its handler finishing (hard crash, OOM, reboot):
 * - a session in a processing stage, untouched for `staleMinutes`, with no live job → `failed`;
 * - a `running` analysis version older than `staleMinutes` whose session has no live job (or was just failed) → `failed`.
 * Returns the ids of the sessions marked failed.
 */
export async function sweepStaleSessions(db: Db, now: Date = new Date(), staleMinutes = 120): Promise<string[]> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
  const stages = sql.join(IN_PROGRESS.map((s) => sql`${s}`), sql`, `);

  const failed = await db.execute<{ id: string }>(sql`
    update sessions s
    set stage = 'failed', error = ${SWEEP_MESSAGE}, updated_at = now()
    where s.stage in (${stages})
      and s.updated_at < ${cutoff.toISOString()}::timestamptz
      and not ${hasLiveJob(sql.raw("s.id"))}
    returning s.id
  `);
  const ids = failed.rows.map((r) => r.id);

  for (const id of ids) {
    const running = await getRunningAnalysis(db, id);
    if (running) await failAnalysisVersion(db, running.id);
  }

  const stale = await db.execute<{ id: string }>(sql`
    select v.id from analysis_versions v
    where v.status = 'running'
      and v.created_at < ${cutoff.toISOString()}::timestamptz
      and not ${hasLiveJob(sql.raw("v.session_id"))}
  `);
  for (const v of stale.rows) await failAnalysisVersion(db, v.id);

  return ids;
}
