import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PgBoss } from "pg-boss";
import type { z } from "zod";
import { JOB_OPTIONS, QUEUES, RenderClipJobSchema, ResumeJobSchema, StartJobSchema } from "@digestor/core";
import { LocalStorage, createDb } from "@digestor/core/server";
import { CLEANUP_CRON, CLEANUP_QUEUE, retentionDays, runCleanup } from "./cleanup.js";
import { handleRenderClip, handleResume, handleStart, MissingApiKeyError, processJobs, type Attempt, type JobContext } from "./jobs.js";
import * as media from "./media/ffmpeg.js";
import { buildPipeline, type PipelineDeps } from "./pipeline/graph.js";
import { AssemblyAITranscriber, type Transcriber } from "./transcribe/assemblyai.js";
import { createAnthropicLLM, type StructuredLLM } from "./llm/structured.js";
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
  for (const name of [...Object.values(QUEUES), CLEANUP_QUEUE]) {
    // Same options as every sender passes (JOB_OPTIONS): retries, 12 h expiry, 60 s heartbeat.
    await boss.createQueue(name, JOB_OPTIONS); // no-op when the queue already exists...
    await boss.updateQueue(name, JOB_OPTIONS); // ...so existing queues get the current options too
  }
  await boss.schedule(CLEANUP_QUEUE, CLEANUP_CRON, {}, { tz: "UTC" });

  // includeMetadata: handlers need retryCount/retryLimit to fail the session only on the final attempt.
  const workOptions = { batchSize: 1, includeMetadata: true } as const;
  const register = <T>(queue: string, schema: z.ZodType<T>, handle: (job: T, attempt: Attempt) => Promise<void>) =>
    boss.work<unknown, void, typeof workOptions>(queue, workOptions, (jobs) => processJobs(queue, schema, handle, jobs));
  await register(QUEUES.start, StartJobSchema, (j, attempt) => handleStart(ctx, j, attempt));
  await register(QUEUES.resume, ResumeJobSchema, (j, attempt) => handleResume(ctx, j, attempt));
  await register(QUEUES.renderClip, RenderClipJobSchema, (j) => handleRenderClip(ctx, j));
  await boss.work(CLEANUP_QUEUE, { batchSize: 1 }, async () => {
    const days = retentionDays();
    const { deleted } = await runCleanup({ db, storage, checkpointer: saver }, days);
    console.log(`cleanup: deleted ${deleted} session(s) older than ${days} day(s)`);
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

  console.log(`worker ready (queues: ${[...Object.values(QUEUES), CLEANUP_QUEUE].join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
