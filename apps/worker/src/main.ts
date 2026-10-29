import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PgBoss } from "pg-boss";
import type { z } from "zod";
import { QUEUES, RenderClipJobSchema, ResumeJobSchema, StartJobSchema } from "@digestor/core";
import { LocalStorage, createDb } from "@digestor/core/server";
import { QUEUE_OPTIONS, handleRenderClip, handleResume, handleStart, MissingApiKeyError, processJobs, type JobContext } from "./jobs.js";
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
  const transcriber: Transcriber = { transcribe: (p) => getTranscriber().transcribe(p) };
  const llm: StructuredLLM = { generate: (a) => getLlm().generate(a) };

  const deps: PipelineDeps = { db, storage, transcriber, llm, media, youtube: { downloadYouTube } };

  const saver = PostgresSaver.fromConnString(databaseUrl);
  await saver.setup();
  const graph = buildPipeline(deps, saver);
  const ctx: JobContext = { db, deps, graph };

  const boss = new PgBoss(databaseUrl);
  boss.on("error", console.error);
  await boss.start();
  for (const name of Object.values(QUEUES)) await boss.createQueue(name, QUEUE_OPTIONS);

  const register = <T>(queue: string, schema: z.ZodType<T>, handle: (job: T) => Promise<void>) =>
    boss.work<unknown>(queue, { batchSize: 1 }, (jobs) => processJobs(queue, schema, handle, jobs));
  await register(QUEUES.start, StartJobSchema, (j) => handleStart(ctx, j));
  await register(QUEUES.resume, ResumeJobSchema, (j) => handleResume(ctx, j));
  await register(QUEUES.renderClip, RenderClipJobSchema, (j) => handleRenderClip(ctx, j));

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

  console.log(`worker ready (queues: ${Object.values(QUEUES).join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
