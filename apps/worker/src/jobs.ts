import { Command } from "@langchain/langgraph";
import { PROFILES, ProfileIdSchema, type AskJob, type FindMoreJob, type NamesJob, type CheckMomentJob, type PrepareTrackJob, type ReanalyzeJob, type TranslateBriefingJob, type ResumeJob, type StartJob } from "@digestor/core";
import {
  claimFindMore,
  failAnalysisVersion,
  failFindMore,
  finishFindMore,
  getFindMoreById,
  listShownRanges,
  getPersons,
  listAttributions,
  getAnalysisTopics,
  failTranslation,
  failRecordFetch,
  getBriefing,
  getTranslation,
  saveTranslation,
  getAnalysisVersion,
  getContextCard,
  getMoment,
  getRunningAnalysis,
  getSession,
  getTranscript,
  releaseMomentCheck,
  failTrack,
  failClipRender,
  failTrackBurn,
  finishAskMessage,
  getAskMessage,
  releaseAskMessage,
  setMomentChecks,
  setStage,
  type Db,
} from "@digestor/core/server";
import { ASK_FAILED, AskRunError, runAsk, type AskDeps } from "./agents/ask.js";
import { findMoreMoments, personConfirmed, personTurnRanges } from "./agents/findMore.js";
import { translateBriefing } from "./agents/translateBriefing.js";
import type { StructuredLLM } from "./llm/structured.js";
import { checkMoment } from "./agents/checks.js";
import { prepareTrack } from "./pipeline/tracks.js";
import { runAnalysis, withProfile } from "./pipeline/analysis.js";
import { RECORD_FETCH_FAILED, RecordStepError, promptCard, runRecordStep } from "./pipeline/naming.js";
import type { BurnTrackJob, RenderClipJob } from "@digestor/core";
import type { PipelineDeps, buildPipeline } from "./pipeline/graph.js";
import { TranscriptionError } from "./transcribe/assemblyai.js";

import { MissingApiKeyError, VideoRemovedError } from "./errors.js";
import { burnTrack, renderClipJob, type RenderDeps } from "./pipeline/render.js";

export { MissingApiKeyError };

export type JobContext = {
  db: Db;
  deps: PipelineDeps;
  graph: Pick<ReturnType<typeof buildPipeline>, "invoke" | "getState">;
};

export const TRANSCRIPTION_FAILED = "Transcription failed. Please try again.";

/**
 * User-facing message for an error that escaped the graph. Vendor text (AssemblyAI's error) and unknown errors are
 * logged, never shown.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof TranscriptionError) {
    console.error(`[jobs] transcription failed: ${err.message}`);
    return TRANSCRIPTION_FAILED;
  }
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
    // The web route claimed a `running` version for this job: fail it now instead of leaving it for the sweep (T17).
    if (job.analysisId && (await getAnalysisVersion(ctx.db, job.analysisId))?.sessionId === job.sessionId) {
      await failAnalysisVersion(ctx.db, job.analysisId);
    }
    return;
  }
  try {
    await runAnalysis(ctx.deps, job.sessionId, { profile: job.profile, reason: job.reason, analysisId: job.analysisId });
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

/**
 * Checks for one moment on demand. Idempotent: a moment that already has checks costs no model call. When the job gives
 * up on its final attempt, the sender's claim (R29) is freed so "Check again" can send a new one; a missing key keeps
 * it, so polling can't queue a job every few seconds while nothing could succeed.
 */
export async function handleCheckMoment(ctx: JobContext, job: CheckMomentJob, attempt: Attempt): Promise<void> {
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
    const card = await promptCard(db, version.sessionId, withProfile(stored.card, profile.data));
    const checks = await checkMoment(ctx.deps.llm, { card, moment, words: transcript.words });
    await setMomentChecks(db, moment.id, checks);
  } catch (err) {
    if (!(err instanceof MissingApiKeyError)) {
      if (attempt.retryCount >= attempt.retryLimit) await releaseMomentCheck(db, moment.id);
      throw err; // transient: pg-boss retries
    }
    console.error(`[jobs] check of moment ${job.momentId} skipped: ${err.message}`);
  }
}

const TRACK_FAILED = "The subtitles could not be prepared. Please try again.";

/**
 * Builds a subtitle track. A missing key fails the track and completes the job; any other error is rethrown for
 * pg-boss to retry and only the final attempt marks the track failed.
 */
export async function handlePrepareTrack(
  ctx: Pick<JobContext, "db"> & { deps: Pick<PipelineDeps, "llm"> },
  job: PrepareTrackJob,
  attempt: Attempt,
): Promise<void> {
  const { db, deps } = ctx;
  try {
    await prepareTrack({ db, llm: deps.llm }, job.trackId);
  } catch (err) {
    if (isDeterministic(err)) {
      console.error(`[jobs] track ${job.trackId} failed: ${(err as Error).message}`);
      await failTrack(db, job.trackId, (err as Error).message);
      return;
    }
    if (attempt.retryCount >= attempt.retryLimit) await failTrack(db, job.trackId, TRACK_FAILED);
    else console.error(`[jobs] track ${job.trackId} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
    throw err;
  }
}

/**
 * Shared policy for render/burn jobs: a removed video is deterministic (mark failed, complete, no retry); any other
 * error is rethrown for pg-boss to retry and only the final attempt marks the row failed.
 */
async function runRender(label: string, id: string, attempt: Attempt, work: () => Promise<void>, fail: () => Promise<void>) {
  try {
    await work();
  } catch (err) {
    if (err instanceof VideoRemovedError) {
      console.error(`[jobs] ${label} ${id} failed: ${err.message}`);
      await fail();
      return;
    }
    if (attempt.retryCount >= attempt.retryLimit) await fail();
    else console.error(`[jobs] ${label} ${id} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
    throw err;
  }
}

export const handleRenderClip = (deps: RenderDeps, job: RenderClipJob, attempt: Attempt) =>
  runRender("clip", job.clipId, attempt, () => renderClipJob(deps, job.clipId), () => failClipRender(deps.db, job.clipId));

export const handleBurnTrack = (deps: RenderDeps, job: BurnTrackJob, attempt: Attempt) =>
  runRender("track burn", job.trackId, attempt, () => burnTrack(deps, job.trackId), () => failTrackBurn(deps.db, job.trackId));

/**
 * Answers one Ask question (the pending assistant message). The message goes `pending` → `running` → `done`, or
 * `failed` with a friendly line. A missing key, or an error after a tool already changed something (a retry would
 * repeat the change), fails at once without a retry; any other error puts the message back to `pending` and is
 * rethrown for pg-boss, and only the final attempt marks it failed. A crash leaves it `running`: the retry fails it.
 */
export async function handleAsk(deps: AskDeps, job: AskJob, attempt: Attempt): Promise<void> {
  try {
    await runAsk(deps, job.messageId);
  } catch (err) {
    const run = err instanceof AskRunError ? err : null;
    const cause = run ? run.cause : err;
    const deterministic = cause instanceof MissingApiKeyError || (run?.sideEffect ?? false);
    if (deterministic || attempt.retryCount >= attempt.retryLimit) {
      console.error(`[jobs] ask ${job.messageId} failed:`, cause);
      const msg = await getAskMessage(deps.db, job.messageId);
      if (msg?.status === "pending" || msg?.status === "running") {
        // A missing key says which one (as sessions do); anything else gets the generic line.
        const text = cause instanceof MissingApiKeyError ? cause.message : ASK_FAILED;
        await finishAskMessage(deps.db, job.messageId, { text, toolCalls: run?.toolCalls ?? [], status: "failed" });
      }
    } else {
      await releaseAskMessage(deps.db, job.messageId); // nothing changed: the retry may run it again
      console.error(`[jobs] ask ${job.messageId} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, cause);
    }
    if (!deterministic) throw cause;
  }
}

export const TRANSLATE_FAILED = "Couldn't translate the briefing. Please try again.";

/**
 * Translates a briefing and stores it (`ready`). A missing key fails the row at once with its message; any other
 * error is rethrown for pg-boss to retry and only the final attempt marks the row failed.
 */
export async function handleTranslateBriefing(
  deps: { db: Db; llm: StructuredLLM },
  job: TranslateBriefingJob,
  attempt: Attempt,
): Promise<void> {
  const { db, llm } = deps;
  const row = await getTranslation(db, job.analysisId, job.language, "briefing");
  if (row?.status !== "pending") return; // never requested, already ready, or the version was replaced
  try {
    const briefing = await getBriefing(db, job.analysisId);
    if (!briefing) throw new Error(`No briefing for analysis ${job.analysisId}`);
    await saveTranslation(db, job.analysisId, job.language, "briefing", await translateBriefing(llm, briefing, job.language));
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      console.error(`[jobs] translation ${job.analysisId}/${job.language} failed:`, err);
      await failTranslation(db, job.analysisId, job.language, "briefing", err.message);
      return;
    }
    if (attempt.retryCount >= attempt.retryLimit) {
      await failTranslation(db, job.analysisId, job.language, "briefing", TRANSLATE_FAILED);
      console.error(`[jobs] translation ${job.analysisId}/${job.language} failed:`, err);
    } else {
      console.error(`[jobs] translation ${job.analysisId}/${job.language} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
    }
    throw err;
  }
}

export const FIND_MORE_FAILED = "Couldn't look for more moments. Please try again.";

/**
 * "Find more moments with <person>": claims the request (`pending` → `running`), runs the one text-only call and
 * stores the moments. A missing key fails the row at once with its message; any other error is rethrown for pg-boss
 * to retry (the retry finds the row `running` and continues) and only the final attempt marks the row failed.
 */
export async function handleFindMore(deps: { db: Db; llm: StructuredLLM }, job: FindMoreJob, attempt: Attempt): Promise<void> {
  const { db, llm } = deps;
  const row = await getFindMoreById(db, job.requestId);
  if (!row) return;
  // A first delivery needs the claim; a retry (after a crash or a transient error) finds its own row `running`.
  if (!(await claimFindMore(db, row.id)) && !(attempt.retryCount > 0 && row.status === "running")) return;
  try {
    const version = await getAnalysisVersion(db, row.analysisId);
    const [transcript, stored, persons] = version
      ? await Promise.all([getTranscript(db, version.sessionId), getContextCard(db, version.sessionId), getPersons(db, [row.personId])])
      : [null, null, []];
    const profile = ProfileIdSchema.safeParse(version?.profile);
    const person = persons[0];
    if (!version || !transcript || !stored || !profile.success || !person) {
      console.log(`[jobs] find-more ${row.id} failed: its session has no transcript, context or person`);
      await failFindMore(db, row.id, FIND_MORE_FAILED);
      return;
    }
    // Only turns the name may be used for: a sensitive profile counts confirmed names only.
    const atts = await listAttributions(db, version.sessionId);
    const turns = personTurnRanges(transcript.words, atts, person.id, PROFILES[profile.data].sensitive);
    const card = await promptCard(db, version.sessionId, withProfile(stored.card, profile.data));
    const found =
      turns.length === 0
        ? []
        : await findMoreMoments(llm, {
            card, transcript, topics: await getAnalysisTopics(db, version.id), personTurns: turns, personName: person.displayName, confirmed: personConfirmed(transcript.words, atts, person.id),
            existing: await listShownRanges(db, { analysisId: row.analysisId, ownerId: row.ownerId, requestId: row.id }),
          });
    await finishFindMore(db, row.id, found);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      console.error(`[jobs] find-more ${row.id} failed: ${err.message}`);
      await failFindMore(db, row.id, err.message);
      return;
    }
    if (attempt.retryCount >= attempt.retryLimit) {
      await failFindMore(db, row.id, FIND_MORE_FAILED);
      console.error(`[jobs] find-more ${row.id} failed:`, err);
    } else {
      console.error(`[jobs] find-more ${row.id} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
    }
    throw err;
  }
}

/**
 * Matches the session's linked official record (`session.names`: a record linked at the context pause or later; at
 * upload the graph's `match_record` node does it). `runRecordStep` fails the row itself for a deterministic result (no
 * speeches for the date, unsupported chamber) and returns. Any other error (5xx, network) is rethrown for pg-boss to
 * retry (the retry takes over its own `running` row), and only the final attempt marks the row failed.
 */
export async function handleNames(ctx: Pick<JobContext, "db" | "deps">, job: NamesJob, attempt: Attempt): Promise<void> {
  try {
    await runRecordStep(ctx.deps, job.sessionId, { retrying: attempt.retryCount > 0 });
  } catch (err) {
    if (attempt.retryCount >= attempt.retryLimit) {
      await failRecordFetch(ctx.db, job.sessionId, RECORD_FETCH_FAILED, err instanceof RecordStepError ? err.ref : undefined);
      console.error(`[jobs] record of ${job.sessionId} failed:`, err);
    } else {
      console.error(`[jobs] record of ${job.sessionId} attempt ${attempt.retryCount + 1} failed; pg-boss will retry:`, err);
    }
    throw err instanceof RecordStepError ? err.original : err;
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
