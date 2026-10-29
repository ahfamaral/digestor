import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import type { JobSender } from "./server";

/**
 * Enqueue session processing. Double submits are prevented by the atomic DB writes before the send (one
 * session row per upload, compare-and-set stage transitions); singletonKey is not relied on, because pg-boss
 * only dedupes on it for queues with a singleton policy and ours use the standard policy.
 */
export function sendStart(boss: JobSender, sessionId: string): Promise<string | null> {
  return boss.send(QUEUES.start, { sessionId }, { ...JOB_OPTIONS, singletonKey: sessionId });
}
