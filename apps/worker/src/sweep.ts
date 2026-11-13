import { sql } from "drizzle-orm";
import { QUEUES } from "@digestor/core";
import { failAnalysisVersion, getRunningAnalysis, settlePreview, type Db } from "@digestor/core/server";

/** pg-boss queue for the stale-session sweep (scheduled every 15 minutes in main.ts). */
export const SWEEP_QUEUE = "session.sweep";
export const SWEEP_CRON = "*/15 * * * *";

export const SWEEP_MESSAGE = "Processing stopped unexpectedly. Please start over.";
/** Written to a stuck job row's error field (R32); the row's own retry path ("Try again", export again) works after it. */
export const STUCK_MESSAGE = "This took too long and was stopped. Please try again.";

/** Stages where a worker job is expected to be running (`awaiting_context` is a human pause, not one of them). */
const IN_PROGRESS = [
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
];

/** `session.proxy` owns a `preparing_preview` session while the copy is encoded (up to ~1 h on a 5 h video; the heartbeat keeps the job live). */
const LIVE_JOB_QUEUES = [QUEUES.start, QUEUES.resume, QUEUES.reanalyze, QUEUES.proxy];

/** SQL: a pg-boss job that may still run for the session whose id is `idCol`. */
const hasLiveJob = (idCol: ReturnType<typeof sql.raw>) => sql`exists (
  select 1 from pgboss.job j
  where j.name in (${sql.join(LIVE_JOB_QUEUES.map((q) => sql`${q}`), sql`, `)})
    and j.state in ('created', 'retry', 'active')
    and j.data->>'sessionId' = ${idCol}::text
)`;

/** SQL: a pg-boss job in `queue` that may still run, whose payload matches every `data->>key = column` pair. */
const hasLiveJobFor = (queue: string, match: Record<string, string>) => sql`exists (
  select 1 from pgboss.job j
  where j.name = ${queue}
    and j.state in ('created', 'retry', 'active')
    ${sql.join(Object.entries(match).map(([key, col]) => sql`and j.data->>${key} = ${sql.raw(col)}::text`), sql` `)}
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

/**
 * R32: the same gap for rows a job owns. A row still waiting on a job, untouched for `staleMinutes`, whose queue holds
 * no live job for it (the job died on its last attempt, or was never sent) is failed, so its normal retry path works:
 * - a `pending` briefing translation → `failed` with STUCK_MESSAGE (the Preview offers to try again);
 * - a `preparing` subtitle track → `failed` with STUCK_MESSAGE ("Try again" replaces it);
 * - a clip render or track burn `queued`/`rendering` → `failed` (exporting again re-claims it);
 * - a "Find more" request `pending`/`running` → `failed` with STUCK_MESSAGE (asking again resets it);
 * - a linked record's fetch `pending`/`running` → `failed` with STUCK_MESSAGE (linking again resets it); `waiting`
 *   (the house hasn't published yet; `records.retry` wakes it) and `suggested` (a suggestion awaiting the journalist)
 *   are not job-owned and are never swept;
 * - an answer across videos (`library_ask_messages`) `pending`/`running` → `failed` with STUCK_MESSAGE as its text
 *   (asking again sends a new question);
 * - a session's preview copy `pending`/`running` → `failed`, then the join runs: a session waiting in `preparing_preview`
 *   fails with its friendly line (one still analysing fails when its analysis ends).
 * Returns how many rows of each kind were failed.
 */
export async function sweepStaleJobRows(
  db: Db,
  now: Date = new Date(),
  staleMinutes = 30,
): Promise<{ translations: number; tracks: number; renders: number; burns: number; findMore: number; records: number; libraryAsk: number; proxies: number }> {
  const cutoff = sql`${new Date(now.getTime() - staleMinutes * 60_000).toISOString()}::timestamptz`;

  const translations = await db.execute(sql`
    update translations t set status = 'failed', error = ${STUCK_MESSAGE}, updated_at = now()
    where t.status = 'pending' and t.updated_at < ${cutoff}
      and not ${hasLiveJobFor(QUEUES.translateBriefing, { analysisId: "t.analysis_id", language: "t.language" })}
  `);
  const tracks = await db.execute(sql`
    update subtitle_tracks t set status = 'failed', error = ${STUCK_MESSAGE}, updated_at = now()
    where t.status = 'preparing' and t.updated_at < ${cutoff}
      and not ${hasLiveJobFor(QUEUES.prepareTrack, { trackId: "t.id" })}
  `);
  const renders = await db.execute(sql`
    update clips c set render_status = 'failed', updated_at = now()
    where c.render_status in ('queued', 'rendering') and c.updated_at < ${cutoff}
      and not ${hasLiveJobFor(QUEUES.renderClip, { clipId: "c.id" })}
  `);
  const burns = await db.execute(sql`
    update subtitle_tracks t set burn_status = 'failed', updated_at = now()
    where t.burn_status in ('queued', 'rendering') and t.updated_at < ${cutoff}
      and not ${hasLiveJobFor(QUEUES.burnTrack, { trackId: "t.id" })}
  `);
  const findMore = await db.execute(sql`
    update find_more_requests r set status = 'failed', error = ${STUCK_MESSAGE}, updated_at = now()
    where r.status in ('pending', 'running') and r.updated_at < ${cutoff}
      and not ${hasLiveJobFor(QUEUES.findMore, { requestId: "r.id" })}
  `);
  const records = await db.execute(sql`
    update session_records r set status = 'failed', error = ${STUCK_MESSAGE}, updated_at = now()
    where r.status in ('pending', 'running') and r.updated_at < ${cutoff}
      -- an accepted suggestion waiting at the context check: the pipeline's match_record_late owns it, no job is meant to exist
      and not (r.status = 'pending' and exists (select 1 from sessions s where s.id = r.session_id and s.stage = 'awaiting_context'))
      and not ${hasLiveJobFor(QUEUES.names, { sessionId: "r.session_id" })}
      and not ${hasLiveJobFor(QUEUES.start, { sessionId: "r.session_id" })}
      and not ${hasLiveJobFor(QUEUES.resume, { sessionId: "r.session_id" })}
  `);
  const libraryAsk = await db.execute(sql`
    update library_ask_messages m set status = 'failed', text = ${STUCK_MESSAGE}, updated_at = now()
    where m.role = 'assistant' and m.status in ('pending', 'running') and m.updated_at < ${cutoff}
      and not ${hasLiveJobFor(QUEUES.askLibrary, { messageId: "m.id" })}
  `);
  // No `updated_at` bump: that clock is the session's own 120-minute rule, which this must not restart.
  const stuckProxies = await db.execute<{ id: string }>(sql`
    update sessions s set proxy_status = 'failed'
    where s.proxy_status in ('pending', 'running') and s.updated_at < ${cutoff}
      and not ${hasLiveJobFor(QUEUES.proxy, { sessionId: "s.id" })}
    returning s.id
  `);
  for (const row of stuckProxies.rows) await settlePreview(db, row.id);
  return {
    translations: translations.rowCount ?? 0,
    tracks: tracks.rowCount ?? 0,
    renders: renders.rowCount ?? 0,
    burns: burns.rowCount ?? 0,
    findMore: findMore.rowCount ?? 0,
    records: records.rowCount ?? 0,
    libraryAsk: libraryAsk.rowCount ?? 0,
    proxies: stuckProxies.rows.length,
  };
}
