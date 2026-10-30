import { Command } from "@langchain/langgraph";
import { ProfileIdSchema, type CheckMomentJob, type PrepareTrackJob, type ReanalyzeJob, type ResumeJob, type StartJob } from "@digestor/core";
import {
  failAnalysisVersion,
  getAnalysisVersion,
  getContextCard,
  getMoment,
  getRunningAnalysis,
  getSession,
  getTranscript,
  getTrack,
  setMomentChecks,
  setStage,
  setTrackCues,
  type Db,
} from "@digestor/core/server";
import { checkMoment } from "./agents/checks.js";
import { prepareTrack } from "./pipeline/tracks.js";
import { runAnalysis, withProfile } from "./pipeline/analysis.js";
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

/** Fails the session's unfinished analysis version, if any (a retry would have reused it). */
async function failRunningAnalysis(db: Db, sessionId: string): Promise<void> {
  const running = await getRunningAnalysis(db, sessionId);
  if (running) await failAnalysisVersion(db, running.id);
}

async function failSession(ctx: JobContext, sessionId: string, err: unknown): Promise<void> {
  const message = failureMessage(err);
  const progress = (await getSession(ctx.db, sessionId))?.progress ?? 0;
  await failRunningAnalysis(ctx.db, sessionId);
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

/**
 * Start (or continue) the pipeline. Idempotent: a checkpoint mid-run (crash/retry) continues from it; a finished
 * thread, or a session that is already `ready`, is left alone — a duplicate start job must not re-run (and re-pay)
 * the whole pipeline. `invoke(input)` on an existing thread would start over from START.
 */
export async function handleStart(ctx: JobContext, job: StartJob, attempt: Attempt): Promise<void> {
  const cfg = threadConfig(job.sessionId);
  try {
    const state = await ctx.graph.getState(cfg);
    if (state.next.length > 0) {
      await ctx.graph.invoke(null, cfg);
    } else if (state.createdAt !== undefined || (await getSession(ctx.db, job.sessionId))?.stage === "ready") {
      // LangGraph only sets createdAt when the thread has a checkpoint: this run already happened.
      console.log(`Ignoring start for ${job.sessionId}: already finished`);
    } else {
      await ctx.graph.invoke({ sessionId: job.sessionId }, cfg);
    }
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
 * A new analysis version of a `ready` session (e.g. with a corrected profile). The session stays `ready` on its current
 * version throughout; a failure never fails the session. Transient errors are rethrown for pg-boss to retry (the
 * `running` version is reused); when the job gives up (missing key, final attempt) the version is marked failed.
 */
export async function handleReanalyze(ctx: JobContext, job: ReanalyzeJob, attempt: Attempt): Promise<void> {
  const session = await getSession(ctx.db, job.sessionId);
  if (session?.stage !== "ready") {
    console.log(`Ignoring reanalysis of ${job.sessionId}: the session is ${session ? session.stage : "gone"}, not ready`);
    return;
  }
  try {
    await runAnalysis(ctx.deps, job.sessionId, { profile: job.profile, reason: job.reason });
  } catch (err) {
    const deterministic = isDeterministic(err);
    if (deterministic || attempt.retryCount >= attempt.retryLimit) {
      await failRunningAnalysis(ctx.db, job.sessionId);
      console.error(`[jobs] reanalysis of ${job.sessionId} failed; the session keeps its current analysis:`, err);
    } else {
      console.error(`[jobs] reanalysis of ${job.sessionId} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
    }
    if (!deterministic) throw err;
  }
}

/** Checks for one moment on demand. Idempotent: a moment that already has checks costs no model call. */
export async function handleCheckMoment(ctx: JobContext, job: CheckMomentJob, _attempt: Attempt): Promise<void> {
  const { db } = ctx;
  const moment = await getMoment(db, job.momentId);
  if (!moment) {
    console.log(`Ignoring check of moment ${job.momentId}: not found`);
    return;
  }
  if (moment.checks) {
    console.log(`Skipping check of moment ${job.momentId}: already checked`);
    return;
  }
  const version = await getAnalysisVersion(db, moment.analysisId);
  const [transcript, stored] = version
    ? await Promise.all([getTranscript(db, version.sessionId), getContextCard(db, version.sessionId)])
    : [null, null];
  const profile = ProfileIdSchema.safeParse(version?.profile);
  if (!version || !transcript || !stored || !profile.success) {
    console.log(`Ignoring check of moment ${job.momentId}: its session has no transcript or context`);
    return;
  }
  try {
    const checks = await checkMoment(ctx.deps.llm, { card: withProfile(stored.card, profile.data), moment, words: transcript.words });
    await setMomentChecks(db, moment.id, checks);
  } catch (err) {
    if (!(err instanceof MissingApiKeyError)) throw err; // transient: pg-boss retries
    console.error(`[jobs] check of moment ${job.momentId} skipped: ${err.message}`);
  }
}

/** Marks a track failed, keeping any cues it has (setTrackCues flips the status only). */
async function failTrack(db: Db, trackId: string): Promise<void> {
  const track = await getTrack(db, trackId);
  if (track && track.status !== "failed") await setTrackCues(db, trackId, track.cues, "failed");
}

/**
 * Builds a subtitle track. A missing key fails the track and completes the job; any other error is rethrown for
 * pg-boss to retry and only the final attempt marks the track failed.
 */
export async function handlePrepareTrack(
  ctx: Pick<JobContext, "db"> & { deps: Pick<PipelineDeps, "storage" | "llm"> },
  job: PrepareTrackJob,
  attempt: Attempt,
): Promise<void> {
  const { db, deps } = ctx;
  try {
    await prepareTrack({ db, storage: deps.storage, llm: deps.llm }, job.trackId);
  } catch (err) {
    if (isDeterministic(err)) {
      console.error(`[jobs] track ${job.trackId} failed: ${(err as Error).message}`);
      await failTrack(db, job.trackId);
      return;
    }
    if (attempt.retryCount >= attempt.retryLimit) await failTrack(db, job.trackId);
    else console.error(`[jobs] track ${job.trackId} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
    throw err;
  }
}

/** Placeholder consumer for a queue whose task hasn't landed yet: completes the job so nothing retries. */
export const notImplemented =
  (queue: string) =>
  async (_job: unknown, _attempt: Attempt): Promise<void> => {
    console.log(`[jobs] ${queue}: not implemented yet; completing the job`);
  };

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
