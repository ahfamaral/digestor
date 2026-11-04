import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import { claimDueRecordRetries, requeueRecordRetry, type Db } from "@digestor/core/server";

export const RECORDS_RETRY_QUEUE = "records.retry";
/** Hourly: a due row waits at most an hour past its time. */
export const RECORDS_RETRY_CRON = "0 * * * *";
/** A record that isn't published yet is looked at again every 6 hours. */
export const RECORD_RETRY_HOURS = 6;

const HOUR_MS = 3_600_000;

/**
 * The hourly job: claims every `waiting` record whose `retry_at` is due (compare-and-set to `pending`, so a second
 * run or a re-link claims nothing twice), then sends one `session.names` job per claimed session. A failed send puts
 * the row back to `waiting` an hour later (same ref only: a re-link meanwhile keeps its new row).
 */
export async function runRecordRetries(
  deps: { db: Db; send: (sessionId: string) => Promise<unknown> },
  now: Date = new Date(),
): Promise<number> {
  const claimed = await claimDueRecordRetries(deps.db, now);
  for (const { sessionId, ref } of claimed) {
    try {
      await deps.send(sessionId);
    } catch (err) {
      console.error(`records.retry: could not queue session ${sessionId}:`, err);
      await requeueRecordRetry(deps.db, sessionId, ref, new Date(now.getTime() + HOUR_MS)); // the claimed ref: a re-link meanwhile stays as it is
    }
  }
  return claimed.length;
}

/** The sender main.ts wires: `session.names` with the standard job options. */
export const namesJob = (boss: { send: (name: string, data: object, opts: object) => Promise<unknown> }) => (sessionId: string) =>
  boss.send(QUEUES.names, { sessionId }, JOB_OPTIONS);
