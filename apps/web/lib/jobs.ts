import { JOB_OPTIONS, QUEUES } from "@digestor/core";
import type { JobSender } from "./server";

/** Enqueue session processing; singletonKey makes double submits for one session a no-op. */
export function sendStart(boss: JobSender, sessionId: string): Promise<string | null> {
  return boss.send(QUEUES.start, { sessionId }, { ...JOB_OPTIONS, singletonKey: sessionId });
}
