import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PgBoss } from "pg-boss";
import type { z } from "zod";
import {
  AskJobSchema,
  BurnTrackJobSchema,
  CheckMomentJobSchema,
  JOB_OPTIONS,
  PrepareTrackJobSchema,
  QUEUES,
  ReanalyzeJobSchema,
  RenderClipJobSchema,
  ResumeJobSchema,
  StartJobSchema,
  TranslateBriefingJobSchema,
} from "@digestor/core";
import { LocalStorage, createDb } from "@digestor/core/server";
import { CLEANUP_CRON, CLEANUP_QUEUE, runVideoRetention, videoRetentionDays } from "./cleanup.js";
import {
  handleCheckMoment,
  handlePrepareTrack,
  handleReanalyze,
  handleResume,
  handleStart,
  MissingApiKeyError,
  notImplemented,
  handleBurnTrack,
  handleRenderClip,
  processJobs,
  type Attempt,
  type JobContext,
} from "./jobs.js";
import * as media from "./media/ffmpeg.js";
import { buildPipeline, type PipelineDeps } from "./pipeline/graph.js";
import { AssemblyAITranscriber, type Transcriber } from "./transcribe/assemblyai.js";
import { createAnthropicLLM, type StructuredLLM } from "./llm/structured.js";
import { SWEEP_CRON, SWEEP_QUEUE, sweepStaleSessions } from "./sweep.js";
import { downloadYouTube } from "./youtube/ytdlp.js";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile); // host runs; compose already sets process.env

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** Reads the key at first use so the worker can run (and fail jobs clearly) without keys. */
function lazy<T>(varName: string, make: (key: string) => T): () => T {
  let inst: T | undefined;
  return () => {
    if (inst) return inst;
    const key = process.env[varName];
    if (!key) throw new MissingApiKeyError(varName);
    return (inst = make(key));
  };
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const { db, close } = createDb(databaseUrl);
  const storage = new LocalStorage(process.env.DATA_DIR ?? "./data");

  const getTranscriber = lazy("ASSEMBLYAI_API_KEY", (k) => new AssemblyAITranscriber(k));
  const getLlm = lazy("ANTHROPIC_API_KEY", createAnthropicLLM);
  const transcriber: Transcriber = { transcribe: (p, fallbackDurationMs) => getTranscriber().transcribe(p, fallbackDurationMs) };
  const llm: StructuredLLM = { generate: (a) => getLlm().generate(a) };

  const deps: PipelineDeps = { db, storage, transcriber, llm, media, youtube: { downloadYouTube } };

  const saver = PostgresSaver.fromConnString(databaseUrl);
  await saver.setup();
  const graph = buildPipeline(deps, saver);
  const ctx: JobContext = { db, deps, graph };

  const boss = new PgBoss(databaseUrl);
  boss.on("error", console.error);
  await boss.start();
  for (const name of [...Object.values(QUEUES), CLEANUP_QUEUE, SWEEP_QUEUE]) {
    // Same options as every sender passes (JOB_OPTIONS): retries, 12 h expiry, 60 s heartbeat.
    await boss.createQueue(name, JOB_OPTIONS); // no-op when the queue already exists...
    await boss.updateQueue(name, JOB_OPTIONS); // ...so existing queues get the current options too
  }
  await boss.schedule(CLEANUP_QUEUE, CLEANUP_CRON, {}, { tz: "UTC" });
  await boss.schedule(SWEEP_QUEUE, SWEEP_CRON, {}, { tz: "UTC" });

  // includeMetadata: handlers need retryCount/retryLimit to fail the session only on the final attempt.
  const workOptions = { batchSize: 1, includeMetadata: true } as const;
  const register = <T>(queue: string, schema: z.ZodType<T>, handle: (job: T, attempt: Attempt) => Promise<void>) =>
    boss.work<unknown, void, typeof workOptions>(queue, workOptions, (jobs) => processJobs(queue, schema, handle, jobs));
  await register(QUEUES.start, StartJobSchema, (j, attempt) => handleStart(ctx, j, attempt));
  await register(QUEUES.resume, ResumeJobSchema, (j, attempt) => handleResume(ctx, j, attempt));
  await register(QUEUES.reanalyze, ReanalyzeJobSchema, (j, attempt) => handleReanalyze(ctx, j, attempt));
  await register(QUEUES.checkMoment, CheckMomentJobSchema, (j, attempt) => handleCheckMoment(ctx, j, attempt));
  // Consumers land with their tasks (11: prepare, 12: burn + render, 14: ask, 17: translate); until then jobs complete.
  await register(QUEUES.prepareTrack, PrepareTrackJobSchema, (j, attempt) => handlePrepareTrack(ctx, j, attempt));
  await register(QUEUES.burnTrack, BurnTrackJobSchema, (j, attempt) => handleBurnTrack({ db, storage }, j, attempt));
  await register(QUEUES.renderClip, RenderClipJobSchema, (j, attempt) => handleRenderClip({ db, storage }, j, attempt));
  await register(QUEUES.ask, AskJobSchema, notImplemented(QUEUES.ask));
  await register(QUEUES.translateBriefing, TranslateBriefingJobSchema, notImplemented(QUEUES.translateBriefing));
  await boss.work(CLEANUP_QUEUE, { batchSize: 1 }, async () => {
    const days = videoRetentionDays();
    const { removed } = await runVideoRetention({ db, storage, checkpointer: saver }, days);
    console.log(`cleanup: removed the video of ${removed} session(s) older than ${days} day(s)`);
  });
  await boss.work(SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const ids = await sweepStaleSessions(db);
    if (ids.length > 0) console.log(`sweep: marked ${ids.length} stale session(s) failed`);
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await boss.stop({ graceful: true, timeout: 8000 });
      await close();
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`worker ready (queues: ${[...Object.values(QUEUES), CLEANUP_QUEUE, SWEEP_QUEUE].join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
