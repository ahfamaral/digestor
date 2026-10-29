import { Command } from "@langchain/langgraph";
import type { RenderClipJob, ResumeJob, StartJob } from "@digestor/core";
import { getSession, setStage, type Db } from "@digestor/core/server";
import { renderOne, type PipelineDeps, type buildPipeline } from "./pipeline/graph.js";
import { TranscriptionError } from "./transcribe/assemblyai.js";

export class MissingApiKeyError extends Error {
  constructor(public readonly varName: string) {
    super(`${varName} is not set on the server.`);
    this.name = "MissingApiKeyError";
  }
}

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

async function failSession(ctx: JobContext, sessionId: string, err: unknown): Promise<void> {
  const message = failureMessage(err);
  const progress = (await getSession(ctx.db, sessionId))?.progress ?? 0;
  await setStage(ctx.db, sessionId, "failed", progress, message);
}

export async function handleStart(ctx: JobContext, job: StartJob): Promise<void> {
  const cfg = threadConfig(job.sessionId);
  try {
    const state = await ctx.graph.getState(cfg);
    // A checkpoint mid-run (crash/retry): continue from it instead of starting over.
    if (state.next.length > 0) await ctx.graph.invoke(null, cfg);
    else await ctx.graph.invoke({ sessionId: job.sessionId }, cfg);
  } catch (err) {
    await failSession(ctx, job.sessionId, err);
    throw err;
  }
}

export async function handleResume(ctx: JobContext, job: ResumeJob): Promise<void> {
  try {
    await ctx.graph.invoke(new Command({ resume: job.payload }), threadConfig(job.sessionId));
  } catch (err) {
    await failSession(ctx, job.sessionId, err);
    throw err;
  }
}

/** renderOne already records renderStatus=failed and rethrows. */
export async function handleRenderClip(ctx: JobContext, job: RenderClipJob): Promise<void> {
  await renderOne(ctx.deps, job.clipId);
}
