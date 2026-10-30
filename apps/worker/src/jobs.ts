import { Command } from "@langchain/langgraph";
import type { ResumeJob, StartJob } from "@digestor/core";
import { getSession, setStage, type Db } from "@digestor/core/server";
import type { PipelineDeps, buildPipeline } from "./pipeline/graph.js";
import { TranscriptionError } from "./transcribe/assemblyai.js";

import { MissingApiKeyError } from "./errors.js";

export { MissingApiKeyError };

export type JobContext = {
  db: Db;
  deps: PipelineDeps;
  graph: Pick<ReturnType<typeof buildPipeline>, "invoke" | "getState">;
};

/** User-facing message for an error that escaped the graph. Unknown errors are logged, not shown. */
export function failureMessage(err: unknown): string {
  if (err instanceof TranscriptionError) return `Transcription failed: ${err.message}`;
  if (err instanceof MissingApiKeyError) return err.message;
  console.error(err);
  return "Something went wrong while processing this video. Please try again.";
}

const threadConfig = (sessionId: string) => ({ configurable: { thread_id: sessionId } });

/** Which pg-boss attempt is running (from the job metadata): retryCount 0 is the first try. */
export type Attempt = { retryCount: number; retryLimit: number };

async function failSession(ctx: JobContext, sessionId: string, err: unknown): Promise<void> {
  const message = failureMessage(err);
  const progress = (await getSession(ctx.db, sessionId))?.progress ?? 0;
  await setStage(ctx.db, sessionId, "failed", progress, message);
}

/** Errors a retry can't fix (vendor rejected the file, key missing): fail at once instead of retrying. */
const isDeterministic = (err: unknown): boolean => err instanceof TranscriptionError || err instanceof MissingApiKeyError;

/**
 * A deterministic error fails the session and completes the job (no rethrow, so no retry). Any other error is
 * rethrown so pg-boss retries it; only the final attempt marks the session failed — earlier ones leave the
 * in-progress stage alone, so the UI keeps showing progress instead of "Start over" while a retry is pending.
 */
async function onJobError(ctx: JobContext, sessionId: string, err: unknown, attempt: Attempt): Promise<void> {
  if (isDeterministic(err)) {
    await failSession(ctx, sessionId, err);
    return;
  }
  if (attempt.retryCount >= attempt.retryLimit) await failSession(ctx, sessionId, err);
  else console.error(`[jobs] session ${sessionId} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
  throw err;
}

export async function handleStart(ctx: JobContext, job: StartJob, attempt: Attempt): Promise<void> {
  const cfg = threadConfig(job.sessionId);
  try {
    const state = await ctx.graph.getState(cfg);
    // A checkpoint mid-run (crash/retry): continue from it instead of starting over.
    if (state.next.length > 0) await ctx.graph.invoke(null, cfg);
    else await ctx.graph.invoke({ sessionId: job.sessionId }, cfg);
  } catch (err) {
    await onJobError(ctx, job.sessionId, err, attempt);
  }
}

/** Idempotent: a retried or duplicated resume must not pre-answer a later interrupt or restart a finished thread. */
export async function handleResume(ctx: JobContext, job: ResumeJob, attempt: Attempt): Promise<void> {
  const cfg = threadConfig(job.sessionId);
  try {
    const state = await ctx.graph.getState(cfg);
    if (state.tasks.some((t) => (t.interrupts?.length ?? 0) > 0)) {
      await ctx.graph.invoke(new Command({ resume: job.payload }), cfg);
    } else if (state.next.length > 0) {
      await ctx.graph.invoke(null, cfg);
    } else {
      console.log(`Ignoring resume for ${job.sessionId}: nothing is waiting for an answer`);
    }
  } catch (err) {
    await onJobError(ctx, job.sessionId, err, attempt);
  }
}

/**
 * Validate and handle a pg-boss batch (fetched with includeMetadata, so each job carries its attempt).
 * Invalid payloads are logged and completed: retrying garbage can't succeed.
 */
export async function processJobs<T>(
  queue: string,
  schema: { safeParse(d: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
  handle: (data: T, attempt: Attempt) => Promise<void>,
  jobs: ({ data: unknown } & Attempt)[],
): Promise<void> {
  for (const job of jobs) {
    const parsed = schema.safeParse(job.data);
    if (!parsed.success) {
      console.error(`Dropping invalid payload on ${queue}: ${parsed.error.message}`);
      continue;
    }
    await handle(parsed.data, { retryCount: job.retryCount, retryLimit: job.retryLimit });
  }
}
