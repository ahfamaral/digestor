import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ChromaClient } from "chromadb";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PgBoss } from "pg-boss";
import type { z } from "zod";
import {
  AskJobSchema,
  AskResumeJobSchema,
  BurnTrackJobSchema,
  CheckMomentJobSchema,
  FindMoreJobSchema,
  JOB_OPTIONS,
  LibraryAskJobSchema,
  NamesJobSchema,
  PrepareTrackJobSchema,
  ProxyJobSchema,
  QUEUES,
  ReanalyzeJobSchema,
  RenderClipJobSchema,
  ResumeJobSchema,
  StartJobSchema,
  TranslateBriefingJobSchema,
} from "@digestor/core";
import { LocalStorage, createDb } from "@digestor/core/server";
import { CLEANUP_CRON, CLEANUP_QUEUE, runDailyCleanup, videoRetentionDays } from "./cleanup.js";
import {
  handleAsk,
  handleAskResume,
  handleCheckMoment,
  handleFindMore,
  handleLibraryAsk,
  handleNames,
  handleProxy,
  handlePrepareTrack,
  handleReanalyze,
  handleResume,
  handleStart,
  MissingApiKeyError,
  handleTranslateBriefing,
  handleBurnTrack,
  handleRenderClip,
  processJobs,
  type Attempt,
  type JobContext,
} from "./jobs.js";
import * as media from "./media/ffmpeg.js";
import type { PipelineDeps } from "./pipeline/run.js";
import { AssemblyAITranscriber, deferredTranscriber } from "./transcribe/assemblyai.js";
import { createAnthropicLLM, type StructuredLLM } from "./llm/structured.js";
import { createAnthropicToolLLM, type ToolLLM } from "./llm/tools.js";
import { createOpenRouterLLM, createOpenRouterToolLLM } from "./llm/openrouter.js";
import { llmConfigFromEnv } from "./llm/provider.js";
import { createE5Embedder } from "./search/embed.js";
import { indexedSessions, searchTranscript } from "./search/index.js";
import { RECORDS_RETRY_CRON, RECORDS_RETRY_QUEUE, namesJob, runRecordRetries } from "./records/retry.js";
import { MONITOR_REFRESH_CRON, MONITOR_REFRESH_QUEUE, nightlyWindow, refreshMonitor } from "./monitor/refresh.js";
import { MONITOR_VIDEO_CRON, MONITOR_VIDEO_QUEUE, runSessionVideos, videoJobEnabled } from "./monitor/video.js";
import { embedSpeeches, MONITOR_EMBED_CRON, MONITOR_EMBED_QUEUE, searchSpeechMeaning, speechPassages } from "./monitor/embedSpeeches.js";
import { DEFAULT_HTTP_PORT, startHttpServer } from "./http.js";
import { fetchCaptions } from "./youtube/captions.js";
import { SWEEP_CRON, SWEEP_QUEUE, sweepStaleJobRows, sweepStaleSessions } from "./sweep.js";
import { downloadYouTube } from "./youtube/ytdlp.js";

/** Postgres schema of Ask's LangGraph checkpointer (created by migration 0026; `setup()` adds its tables). */
const ASK_GRAPH_SCHEMA = "ask_graph";

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
  const transcriber = deferredTranscriber(getTranscriber);
  const llmConfig = llmConfigFromEnv();
  const openRouter = llmConfig.provider === "openrouter";
  console.log(`LLM provider: ${llmConfig.provider} (reasoning ${llmConfig.models.reasoning}, fast ${llmConfig.models.fast})`);
  const getLlm = lazy(llmConfig.keyVar, (k) => (openRouter ? createOpenRouterLLM(k, llmConfig.models) : createAnthropicLLM(k)));
  const llm: StructuredLLM = { modelIds: llmConfig.recordedModels, generate: (a) => getLlm().generate(a) };
  const getToolLlm = lazy(llmConfig.keyVar, (k) => (openRouter ? createOpenRouterToolLLM(k, llmConfig.models) : createAnthropicToolLLM(k)));
  const toolLlm: ToolLLM = { step: (a) => getToolLlm().step(a) };

  const chromaUrl = new URL(process.env.CHROMA_URL ?? "http://localhost:8000");
  const chroma = new ChromaClient({
    host: chromaUrl.hostname,
    port: Number(chromaUrl.port || (chromaUrl.protocol === "https:" ? 443 : 80)),
    ssl: chromaUrl.protocol === "https:",
  });
  const embedder = createE5Embedder(); // loads the model on first use

  const deps: PipelineDeps = { db, storage, transcriber, llm, media, youtube: { downloadYouTube }, search: { chroma, embedder } };

  // `enqueueNames` and `enqueueProxy` are wired once the queue exists (below).
  const ctx: JobContext = { db, deps };

  // Ask's LangGraph checkpoints (one thread per answer, so a paused answer survives restarts): schema ask_graph.
  const askCheckpointer = PostgresSaver.fromConnString(databaseUrl, { schema: ASK_GRAPH_SCHEMA });
  await askCheckpointer.setup();

  const boss = new PgBoss(databaseUrl);
  boss.on("error", console.error);
  await boss.start();
  for (const name of [...Object.values(QUEUES), CLEANUP_QUEUE, SWEEP_QUEUE, RECORDS_RETRY_QUEUE, MONITOR_REFRESH_QUEUE, MONITOR_VIDEO_QUEUE, MONITOR_EMBED_QUEUE]) {
    // Same options as every sender passes (JOB_OPTIONS): retries, 12 h expiry, 60 s heartbeat.
    await boss.createQueue(name, JOB_OPTIONS); // no-op when the queue already exists...
    await boss.updateQueue(name, JOB_OPTIONS); // ...so existing queues get the current options too
  }
  deps.enqueueNames = async (sessionId) => {
    await boss.send(QUEUES.names, { sessionId }, JOB_OPTIONS);
  };
  deps.enqueueProxy = async (sessionId) => {
    await boss.send(QUEUES.proxy, { sessionId }, JOB_OPTIONS);
  };
  await boss.schedule(CLEANUP_QUEUE, CLEANUP_CRON, {}, { tz: "UTC" });
  await boss.schedule(SWEEP_QUEUE, SWEEP_CRON, {}, { tz: "UTC" });
  await boss.schedule(RECORDS_RETRY_QUEUE, RECORDS_RETRY_CRON, {}, { tz: "UTC" });
  await boss.schedule(MONITOR_REFRESH_QUEUE, MONITOR_REFRESH_CRON, {}, { tz: "UTC" });
  await boss.schedule(MONITOR_EMBED_QUEUE, MONITOR_EMBED_CRON, {}, { tz: "UTC" });
  // The schedule lives in the database: switched off, it is removed, so a restart never brings the job back.
  const videoJob = videoJobEnabled(process.env);
  if (videoJob) await boss.schedule(MONITOR_VIDEO_QUEUE, MONITOR_VIDEO_CRON, {}, { tz: "UTC" });
  else await boss.unschedule(MONITOR_VIDEO_QUEUE);

  // includeMetadata: handlers need retryCount/retryLimit to fail the session only on the final attempt.
  const workOptions = { batchSize: 1, includeMetadata: true } as const;
  const register = <T>(queue: string, schema: z.ZodType<T>, handle: (job: T, attempt: Attempt) => Promise<void>) =>
    boss.work<unknown, void, typeof workOptions>(queue, workOptions, (jobs) => processJobs(queue, schema, handle, jobs));
  await register(QUEUES.start, StartJobSchema, (j, attempt) => handleStart(ctx, j, attempt));
  await register(QUEUES.resume, ResumeJobSchema, (j, attempt) => handleResume(ctx, j, attempt));
  await register(QUEUES.reanalyze, ReanalyzeJobSchema, (j, attempt) => handleReanalyze(ctx, j, attempt));
  await register(QUEUES.checkMoment, CheckMomentJobSchema, (j, attempt) => handleCheckMoment(ctx, j, attempt));
  await register(QUEUES.prepareTrack, PrepareTrackJobSchema, (j, attempt) => handlePrepareTrack(ctx, j, attempt));
  await register(QUEUES.burnTrack, BurnTrackJobSchema, (j, attempt) => handleBurnTrack({ db, storage }, j, attempt));
  await register(QUEUES.renderClip, RenderClipJobSchema, (j, attempt) => handleRenderClip({ db, storage }, j, attempt));
  const askDeps = {
    db, llm: toolLlm, judge: llm, search: (id: string, q: string, k: number) => searchTranscript(deps.search, id, q, k), checkpointer: askCheckpointer,
    // Clip packages: the tool claims each track/render in the database first, then sends its job here.
    send: async (queue: string, data: Record<string, string>, singletonKey: string) => {
      await boss.send(queue, data, { ...JOB_OPTIONS, singletonKey });
    },
  };
  await register(QUEUES.ask, AskJobSchema, (j, attempt) => handleAsk(askDeps, j, attempt));
  await register(QUEUES.askResume, AskResumeJobSchema, (j, attempt) => handleAskResume(askDeps, j, attempt));
  // Ask across videos: read-only (no checkpointer, no sends); the fast model routes and judges.
  const libraryDeps = {
    db, llm: toolLlm, judge: llm, search: askDeps.search, indexed: (ids: string[]) => indexedSessions(chroma, ids), retentionDays: videoRetentionDays(),
  };
  await register(QUEUES.askLibrary, LibraryAskJobSchema, (j, attempt) => handleLibraryAsk(libraryDeps, j, attempt));
  await register(QUEUES.translateBriefing, TranslateBriefingJobSchema, (j, attempt) => handleTranslateBriefing({ db, llm }, j, attempt));
  await register(QUEUES.findMore, FindMoreJobSchema, (j, attempt) => handleFindMore({ db, llm }, j, attempt));
  await register(QUEUES.names, NamesJobSchema, (j, attempt) => handleNames(ctx, j, attempt));
  await register(QUEUES.proxy, ProxyJobSchema, (j, attempt) => handleProxy({ db, storage, media }, j, attempt));
  await boss.work(CLEANUP_QUEUE, { batchSize: 1 }, async () => {
    await runDailyCleanup({ db, storage, chroma }, videoRetentionDays());
  });
  await boss.work(SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const ids = await sweepStaleSessions(db);
    if (ids.length > 0) console.log(`sweep: marked ${ids.length} stale session(s) failed`);
    const rows = await sweepStaleJobRows(db);
    if (Object.values(rows).some((n) => n > 0)) console.log("sweep: marked stuck job rows failed", rows);
  });

  await boss.work(RECORDS_RETRY_QUEUE, { batchSize: 1 }, async () => {
    const n = await runRecordRetries({ db, send: namesJob(boss) });
    if (n > 0) console.log(`records.retry: re-checking the official record of ${n} session(s)`);
  });
  // Parliament monitor: a throw retries the whole refresh (JOB_OPTIONS); every write is an upsert or a window replace.
  await boss.work(MONITOR_REFRESH_QUEUE, { batchSize: 1 }, async () => {
    const counts = await refreshMonitor({ db, fetch }, nightlyWindow());
    console.log("monitor.refresh:", JSON.stringify(counts));
  });
  // Search by meaning: new speeches into the index, revised ones' old chunks out. A throw retries; reruns are safe.
  const meaning = { db, chroma, embedder };
  await boss.work(MONITOR_EMBED_QUEUE, { batchSize: 1 }, async () => {
    const out = await embedSpeeches(meaning);
    console.log("monitor.embed:", JSON.stringify(out));
  });
  // Video evidence (only with MONITOR_VIDEO_ENABLED=true): a session's failure is recorded on its row, never thrown.
  if (videoJob) {
    await boss.work(MONITOR_VIDEO_QUEUE, { batchSize: 1 }, async () => {
      const out = await runSessionVideos({ db, fetch, captions: (id) => fetchCaptions(id), pause: () => new Promise((r) => setTimeout(r, 5000)) });
      if (out.results.length > 0 || out.queued.added > 0) console.log("monitor.video:", JSON.stringify(out));
    });
  } else {
    console.log("monitor.video: off (MONITOR_VIDEO_ENABLED is not \"true\")");
  }

  // Internal HTTP (search by meaning for the web app): loopback in dev, the compose network in prod; no auth.
  const httpPort = Number(process.env.WORKER_HTTP_PORT) || DEFAULT_HTTP_PORT;
  const http = startHttpServer(
    { search: (q, k) => searchSpeechMeaning(meaning, q, k), passages: (q, keys, per) => speechPassages(meaning, q, keys, per) },
    httpPort,
  );
  // Load the e5 model now, so the first search doesn't wait for it (the web gives up after 3 s).
  embedder.embed(["warm-up"], "query").catch((err) => console.error("e5 warm-up failed:", err));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      http.close();
      await boss.stop({ graceful: true, timeout: 8000 });
      await askCheckpointer.end();
      await close();
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`worker ready (queues: ${[...Object.values(QUEUES), CLEANUP_QUEUE, SWEEP_QUEUE, RECORDS_RETRY_QUEUE, MONITOR_REFRESH_QUEUE, MONITOR_VIDEO_QUEUE, MONITOR_EMBED_QUEUE].join(", ")}; http :${httpPort})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
