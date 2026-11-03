import { access, copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChromaClient } from "chromadb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";
import { personAt, type RecordRef, type ContextCard, type Fact, type ResumePayload, type Transcript, type Word } from "@digestor/core";
import {
  LocalStorage,
  createDb,
  createSession,
  getContextCard,
  getCurrentAnalysis,
  getTranscript,
  getPersons,
  getSession,
  claimRecordFetch,
  getSessionRecord,
  linkRecord,
  listAnalysisVersions,
  listAttributions,
  replaceAiAttributions,
  saveTranscript,
  createCustomPerson,
  setHumanAttribution,
  updateSession,
  claimProxy,
  failProxy,
  PREVIEW_FAILED,
  type Db,
} from "@digestor/core/server";
import * as media from "../media/ffmpeg.js";
import { FakeTranscriber, TranscriptionError, type Transcriber } from "../transcribe/assemblyai.js";
import { handleStart, type JobContext } from "../jobs.js";
import { MissingApiKeyError } from "../errors.js";
import { FakeLLM } from "../llm/structured.js";
import { FakeEmbedder } from "../search/embed.js";
import { collectionName, deleteSessionIndex } from "../search/index.js";
import { analysisResponses, captionOf, crashOnInsert, emptyAnalysisResponses } from "./fakeAnalysis.js";
import { nameSpeakersNode } from "./naming.js";
import { FIXTURE_DATE, fakeSenadoFetch, transcriptOfSpeeches } from "../records/fakeSenado.js";
import { YouTubeDownloadError, mapYtDlpError, type YouTubeMetadata, type downloadYouTube } from "../youtube/ytdlp.js";
import { analyzeNode, buildPipeline, type PipelineDeps } from "./graph.js";
import { runProxy } from "./proxy.js";

const TMP = fileURLToPath(new URL("../../test/tmp/", import.meta.url));
const LONG = `${TMP}long.mp4`; // 100 s with audio
const AUDIO = `${TMP}long.m4a`; // 100 s, audio only
const SILENT = `${TMP}silent.mp4`; // 6 s without audio

// One 2 s sentence every 3 s ("Sentence number N."), speaker A: 33 sentences in 100 s.
function mkWords(sentences: number): Word[] {
  const out: Word[] = [];
  for (let s = 0; s < sentences; s++) {
    ["Sentence", "number", `${s}.`].forEach((text, i) =>
      out.push({ text, startMs: s * 3000 + i * 600, endMs: s * 3000 + i * 600 + 500, speaker: "A", confidence: 0.99 }),
    );
  }
  return out;
}
const transcript: Transcript = { language: "en", languageConfidence: 0.97, durationMs: 100_000, words: mkWords(33) };

const none: Fact = { value: null, source: null, evidence: null };
const fact = (value: string, source: Fact["source"], evidence: string): Fact => ({ value, source, evidence });

/** LLM draft card: profile and speaker A are grounded in the transcript; the date is whatever is passed. */
function draft(date: Fact = none): ContextCard {
  return {
    language: none,
    profile: { value: "interview", confidence: 0.9, evidence: "Sentence number 2." },
    title: none,
    summary: "An interview.",
    setting: none,
    dateOrYear: date,
    participants: [{ speakerId: "A", name: none, role: fact("host", "video", "Sentence number 1."), affiliation: none }],
    sufficient: false,
    openQuestions: [],
  };
}
const sufficientDraft = () => draft(fact("2026", "video", "Sentence number 3."));

/** The analysis calls: the frame reads of `name_speakers` are asserted in their own tests. */
const modelCalls = (llm: FakeLLM) => llm.calls.filter((c) => c.name !== "captions");

const exists = (p: string) => access(p).then(() => true, () => false);

let db: Db;
let close: () => Promise<void>;
let root: string;
let storage: LocalStorage;

beforeAll(async () => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
  root = await mkdtemp(path.join(os.tmpdir(), "digestor-graph-"));
  storage = new LocalStorage(root);
});
afterAll(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});

type Setup = {
  /** context_card responses, one per round. */
  context?: unknown[];
  /** Analysis responses by call name; default: the model finds nothing (one fallback topic, no moments). */
  analysis?: Record<string, unknown[]>;
  db?: Db;
  transcript?: Transcript;
  transcriber?: Transcriber;
  fixture?: string;
  audioOnlyAck?: boolean;
  youtube?: typeof downloadYouTube;
  media?: PipelineDeps["media"];
  search?: PipelineDeps["search"];
  /** The graph's way to send `session.names` (a transient record failure hands the row back to the job). */
  enqueueNames?: PipelineDeps["enqueueNames"];
  /** The graph's way to request the preview copy; default: the copy is made at once, as the job would. */
  enqueueProxy?: PipelineDeps["enqueueProxy"];
  /** A record linked at upload (its fetches go through `fetch`). */
  record?: RecordRef;
  fetch?: typeof fetch;
};

const notCalled: typeof downloadYouTube = async () => {
  throw new Error("downloadYouTube should not be called");
};

const testChroma = new ChromaClient({ host: new URL(process.env.CHROMA_URL ?? "http://chroma:8000").hostname, port: 8000 });

async function setup(o: Setup = {}) {
  const session = o.youtube
    ? await createSession(db, { title: "YouTube video", source: "youtube", sourceUrl: "https://www.youtube.com/watch?v=abc" })
    : await createSession(db, { title: "Upload", source: "upload" });
  if (!o.youtube) {
    const originalKey = storage.key(session.id, "original.mp4");
    await copyFile(o.fixture ?? LONG, storage.resolve(originalKey));
    await updateSession(db, session.id, { originalKey, ...(o.audioOnlyAck ? { audioOnlyAck: true } : {}) });
  }
  if (o.record) await linkRecord(db, session.id, o.record);
  const llm = new FakeLLM({ byName: { context_card: o.context ?? [], ...(o.analysis ?? emptyAnalysisResponses()) } });
  const contextCalls = () => llm.calls.filter((c) => c.name === "context_card");
  const deps: PipelineDeps = {
    db: o.db ?? db,
    storage,
    transcriber: o.transcriber ?? new FakeTranscriber(o.transcript ?? transcript),
    llm,
    media: o.media ?? media,
    youtube: { downloadYouTube: o.youtube ?? notCalled },
    search: o.search ?? { chroma: testChroma, embedder: new FakeEmbedder() },
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.enqueueNames ? { enqueueNames: o.enqueueNames } : {}),
  };
  deps.enqueueProxy = o.enqueueProxy ?? (async (id) => runProxy({ db: deps.db, storage, media: deps.media }, id));
  const graph = buildPipeline(deps, new MemorySaver());
  const cfg = { configurable: { thread_id: session.id } };
  const resume = (payload: ResumePayload) => graph.invoke(new Command({ resume: payload }), cfg);
  const interruptValue = async () => (await graph.getState(cfg)).tasks[0]?.interrupts[0]?.value;
  return { sessionId: session.id, llm, contextCalls, deps, graph, cfg, resume, interruptValue };
}

const youtubeStub =
  (metadata: YouTubeMetadata): typeof downloadYouTube =>
  async (_url, outPathNoExt) => {
    await copyFile(LONG, `${outPathNoExt}.mp4`);
    return { videoPath: `${outPathNoExt}.mp4`, metadata };
  };

describe("pipeline", () => {
  it("pauses for context when the date is missing", async () => {
    const enqueueProxy = vi.fn(async (_id: string) => {});
    const { graph, cfg, sessionId, llm, interruptValue } = await setup({ context: [draft()], enqueueProxy });
    await graph.invoke({ sessionId }, cfg);
    const st = await graph.getState(cfg);
    expect(st.tasks[0]!.interrupts[0]!.value).toEqual({ type: "context" });
    expect(await interruptValue()).toEqual({ type: "context" });

    const s = (await getSession(db, sessionId))!;
    expect(s).toMatchObject({ stage: "awaiting_context", progress: 55, language: "en", profile: "interview" });
    expect(s.audioKey).toBe(`${sessionId}/audio.mp3`);
    expect(s.proxyKey).toBeNull(); // the copy is its own job: proxyKey is set when it is done
    expect(s.proxyStatus).toBe("pending");
    expect(Math.abs(s.durationMs! - 100_000)).toBeLessThan(500);
    expect(await exists(storage.resolve(s.audioKey!))).toBe(true);
    expect(await exists(storage.resolve(`${sessionId}/proxy.mp4`))).toBe(false);

    const stored = (await getContextCard(db, sessionId))!;
    expect(stored.round).toBe(1);
    expect(stored.card.sufficient).toBe(false);
    expect(stored.card.openQuestions.map((q) => q.id)).toEqual(["date"]);
    expect(stored.card.language).toMatchObject({ value: "en", source: "video" });
    expect(modelCalls(llm)).toHaveLength(1);
  });

  it("the transcript is saved before the preview copy exists", async () => {
    const makeProxy = vi.fn(async (_i: string, _o: string) => undefined);
    const enqueueProxy = vi.fn(async (_id: string) => {});
    const { graph, cfg, sessionId } = await setup({ context: [draft()], media: { ...media, makeProxy }, enqueueProxy });
    await graph.invoke({ sessionId }, cfg);
    expect(await getTranscript(db, sessionId)).not.toBeNull();
    expect(makeProxy).not.toHaveBeenCalled();
    expect(enqueueProxy).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(await getSession(db, sessionId)).toMatchObject({ proxyStatus: "pending", proxyKey: null });
  });

  it("a failed send of the copy's job throws, so the node is retried", async () => {
    const enqueueProxy = vi.fn(async () => { throw new Error("queue down"); });
    const { graph, cfg, sessionId } = await setup({ context: [draft()], enqueueProxy });
    await expect(graph.invoke({ sessionId }, cfg)).rejects.toThrow("queue down");
    expect(await getTranscript(db, sessionId)).toBeNull();
  });

  it("the context check pauses with the copy still pending; the analysis then waits for it", async () => {
    const enqueueProxy = vi.fn(async (_id: string) => {});
    const { graph, cfg, sessionId, resume } = await setup({ context: [draft()], enqueueProxy });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context", proxyStatus: "pending", proxyKey: null });
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "preparing_preview", progress: 96, profile: "interview" });
    expect(await getCurrentAnalysis(db, sessionId)).not.toBeNull();
    await runProxy({ db, storage, media }, sessionId); // the job finishes last and closes it
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100, proxyStatus: "done", proxyKey: `${sessionId}/proxy.mp4` });
  });

  it("a copy that failed during the context pause fails the session before the paid analysis", async () => {
    const enqueueProxy = vi.fn(async (_id: string) => {});
    const { graph, cfg, sessionId, llm, resume } = await setup({ context: [draft()], enqueueProxy });
    await graph.invoke({ sessionId }, cfg);
    await claimProxy(db, sessionId);
    await failProxy(db, sessionId); // the job's last attempt (or the sweep) gave up meanwhile
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: PREVIEW_FAILED });
    expect(llm.calls.filter((c) => c.name !== "context_card" && c.name !== "captions")).toHaveLength(0);
    expect(await getCurrentAnalysis(db, sessionId)).toBeNull();
  });

  it("re-running the analysis step on a ready session leaves it ready and untouched", async () => {
    const { graph, cfg, sessionId, deps } = await setup({ context: [sufficientDraft()] });
    await graph.invoke({ sessionId }, cfg);
    const before = await getSession(db, sessionId);
    expect(before).toMatchObject({ stage: "ready" });
    await analyzeNode(deps)({ sessionId } as Parameters<ReturnType<typeof analyzeNode>>[0]); // a replay after a crash before the checkpoint
    const after = await getSession(db, sessionId);
    expect(after).toMatchObject({ stage: "ready", progress: 100 });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("skip goes on to the analysis and ready after the single context pause", async () => {
    const { graph, cfg, sessionId, contextCalls, resume } = await setup({ context: [draft()] });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(contextCalls()).toHaveLength(1); // no second context round
    expect(await getCurrentAnalysis(db, sessionId)).toMatchObject({ version: { version: 1, reason: "initial", profile: "interview" } });
  });

  it("asks one follow-up round with the new questions, then finishes (never a third round)", async () => {
    const { graph, cfg, sessionId, llm, contextCalls, resume, interruptValue } = await setup({ context: [draft(), draft(), draft()] });
    await graph.invoke({ sessionId }, cfg);
    await resume({
      action: "continue",
      answers: [
        { questionId: "date", answer: "Maybe last spring" },
        { questionId: "unknown", answer: "ignored answer" },
      ],
      cardEdits: { title: "Budget hearing", profile: "supreme_court", participants: [{ speakerId: "A", name: "Maria Silva" }] },
    });
    // Still insufficient after round 1's answers: the follow-up round pauses with its own questions.
    expect(await interruptValue()).toEqual({ type: "context" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context", progress: 55 });
    expect(modelCalls(llm).map((c) => c.name)).toEqual(["context_card", "context_card"]);
    expect(modelCalls(llm)[1]!.user).toContain("Q: When was this recorded or first aired?\nA: Maybe last spring");
    expect(modelCalls(llm)[1]!.user).not.toContain("ignored answer");

    const round2 = (await getContextCard(db, sessionId))!;
    expect(round2.round).toBe(2);
    expect(round2.card.sufficient).toBe(false);
    expect(round2.card.openQuestions.map((q) => q.id)).toEqual(["date"]);
    expect(round2.card.title).toEqual({ value: "Budget hearing", source: "human", evidence: "Budget hearing" });
    expect(round2.card.profile).toEqual({ value: "supreme_court", confidence: 1, evidence: "set by user" });
    expect(round2.card.participants).toEqual([
      {
        speakerId: "A",
        name: { value: "Maria Silva", source: "human", evidence: "Maria Silva" },
        role: fact("host", "video", "Sentence number 1."),
        affiliation: none,
      },
    ]);
    expect((await getSession(db, sessionId))!.profile).toBe("supreme_court");
    const humans = (await listAttributions(db, sessionId)).filter((a) => a.source === "human");
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({ speakerId: "A", startMs: null, status: "confirmed" });
    expect((await getPersons(db, [humans[0]!.personId!]))[0]!.displayName).toBe("Maria Silva");

    // The second round's answers are folded into the card, then the pipeline finishes even though it is still insufficient.
    await resume({ action: "continue", answers: [{ questionId: "date", answer: "Sometime in 2025" }], cardEdits: {} });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(contextCalls()).toHaveLength(3);
    expect(modelCalls(llm)[2]!.user).toContain("A: Maybe last spring");
    expect(modelCalls(llm)[2]!.user).toContain("Q: When was this recorded or first aired?\nA: Sometime in 2025");
    expect((await getContextCard(db, sessionId))!.card.sufficient).toBe(false);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
  });

  it("a confirmed human name survives a second context round", async () => {
    const { graph, cfg, sessionId, llm, resume } = await setup({ context: [draft(), draft(), draft()] });
    await graph.invoke({ sessionId }, cfg);
    const p = await createCustomPerson(db, { displayName: "Joana Confirmada", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId, speakerId: "A", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
    await resume({ action: "continue", answers: [{ questionId: "date", answer: "Maybe last spring" }], cardEdits: {} });
    const round2 = (await getContextCard(db, sessionId))!;
    expect(round2.round).toBe(2);
    expect(round2.card.participants.find((x) => x.speakerId === "A")!.name).toEqual({
      value: "Joana Confirmada", source: "human", evidence: "Joana Confirmada",
    });
    expect(round2.card.openQuestions.filter((q) => q.target === "participant")).toEqual([]);
    expect(modelCalls(llm)).toHaveLength(2);
  });

  it("skip after a rename in Who's who: the analysis prompts carry the human name", async () => {
    const { graph, cfg, sessionId, llm, resume } = await setup({ context: [draft()] });
    await graph.invoke({ sessionId }, cfg);
    const p = await createCustomPerson(db, { displayName: "Renomeada Na Pausa", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId, speakerId: "A", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
    const analysis = modelCalls(llm).filter((c) => c.name !== "context_card");
    expect(analysis.length).toBeGreaterThan(0);
    expect(analysis.every((c) => c.system.includes("Renomeada Na Pausa"))).toBe(true);
  });

  it("skipping the follow-up round goes on to ready", async () => {
    const { graph, cfg, sessionId, contextCalls, resume, interruptValue } = await setup({ context: [draft(), draft()] });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "continue", answers: [{ questionId: "date", answer: "no idea" }], cardEdits: {} });
    expect(await interruptValue()).toEqual({ type: "context" });
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    expect(contextCalls()).toHaveLength(2);
  });

  it("sufficient context never pauses for context", async () => {
    const { graph, cfg, sessionId } = await setup({ context: [sufficientDraft()] });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    expect((await getContextCard(db, sessionId))!).toMatchObject({ round: 1, card: { sufficient: true } });
  });

  it("fails cleanly on a video without audio", async () => {
    const { graph, cfg, sessionId, llm } = await setup({ fixture: SILENT });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "This video has no audio track." });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  it("audio-only without acknowledgement fails with the copy", async () => {
    const { graph, cfg, sessionId, llm } = await setup({ fixture: AUDIO });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "This file has no video." });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  it("with acknowledgement continues and sets hasVideo false", async () => {
    const { graph, cfg, sessionId } = await setup({ fixture: AUDIO, audioOnlyAck: true, context: [draft()] });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ hasVideo: false, stage: "awaiting_context", proxyKey: `${sessionId}/proxy.mp4` });
    expect((await graph.getState(cfg)).tasks[0]!.interrupts[0]!.value).toEqual({ type: "context" });
  });

  it("youtube upload date answers the date question", async () => {
    const metadata: YouTubeMetadata = {
      title: "Minister interview",
      description: "Full interview.",
      channel: "Canal X",
      uploadDate: "2026-03-14",
      webpageUrl: "https://www.youtube.com/watch?v=abc",
      durationS: 100,
    };
    const llmDraft = draft(fact("2026-03-14", "metadata", "2026-03-14"));
    const { graph, cfg, sessionId, llm } = await setup({
      youtube: youtubeStub(metadata),
      context: [llmDraft],
    });
    await graph.invoke({ sessionId }, cfg);
    expect((await getSession(db, sessionId))!.stage).toBe("ready");

    const s = (await getSession(db, sessionId))!;
    expect(s.title).toBe("Minister interview");
    expect(s.originalKey).toBe(`${sessionId}/original.mp4`);
    expect(s.metadata).toMatchObject({ uploadDate: "2026-03-14", channel: "Canal X", encoder: expect.any(String) });

    const user = modelCalls(llm)[0]!.user;
    expect(user).toContain("uploadDate: 2026-03-14");
    expect(user).toContain("channel: Canal X");
    expect(user).toContain("title: Minister interview");
    expect(user).not.toContain("durationS");
    expect((await getContextCard(db, sessionId))!.card.dateOrYear).toEqual(fact("2026-03-14", "metadata", "2026-03-14"));
  });

  it("youtube download failure ends with the friendly message", async () => {
    const stderr = "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser";
    const { graph, cfg, sessionId, llm } = await setup({
      youtube: async () => {
        throw new YouTubeDownloadError(mapYtDlpError(stderr), stderr);
      },
    });
    await graph.invoke({ sessionId }, cfg);
    const s = (await getSession(db, sessionId))!;
    expect(s.stage).toBe("failed");
    expect(s.error).toContain("upload the file");
    expect(s.error).not.toContain("ERROR:");
    expect(s.originalKey).toBeNull();
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  it("an unexpected download error ends with the generic message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { graph, cfg, sessionId, llm } = await setup({
        youtube: async () => {
          throw new Error("ENOENT: no such file or directory, open '/data/x/original.info.json'");
        },
      });
      await graph.invoke({ sessionId }, cfg);
      expect(await getSession(db, sessionId)).toMatchObject({
        stage: "failed",
        error: "Couldn't download this video from YouTube.",
      });
      expect(llm.calls.length).toBe(0);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("fails cleanly when no speech is detected", async () => {
    const { graph, cfg, sessionId, llm } = await setup({ transcript: { ...transcript, words: [] } });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "No speech was detected in this video." });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  it("AssemblyAI's 'no spoken audio' error ends with the no-speech message, not a transcription failure", async () => {
    // What AssemblyAI answers (status "error") for a file without speech when language_detection is on.
    const silent: Transcriber = {
      transcribe: async () => {
        throw new TranscriptionError("language_detection cannot be performed on files with no spoken audio.");
      },
    };
    const { graph, cfg, sessionId, llm } = await setup({ transcriber: silent });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "No speech was detected in this video." });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  it("other transcription errors still escape the graph", async () => {
    const broken: Transcriber = {
      transcribe: async () => {
        throw new TranscriptionError("Audio file is corrupt");
      },
    };
    const { graph, cfg, sessionId } = await setup({ transcriber: broken });
    await expect(graph.invoke({ sessionId }, cfg)).rejects.toThrow("Audio file is corrupt");
    await expect(graph.invoke({ sessionId }, cfg)).rejects.toBeInstanceOf(TranscriptionError); // jobs.ts relies on instanceof
  });

  it("passes the probed duration to the transcriber", async () => {
    const seen: (number | undefined)[] = [];
    const recording: Transcriber = {
      transcribe: async (_p, fallbackDurationMs) => {
        seen.push(fallbackDurationMs);
        return { ...transcript, words: [] };
      },
    };
    const { graph, cfg, sessionId } = await setup({ transcriber: recording });
    await graph.invoke({ sessionId }, cfg);
    expect(seen).toHaveLength(1);
    expect(Math.abs(seen[0]! - 100_000)).toBeLessThan(500);
  });

  it.each([
    ["a zero-byte file", ""],
    ["a text file renamed to .mp4", "this is not a video"],
  ])("fails cleanly on an unreadable video (%s)", async (_case, content) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fixture = path.join(root, `unreadable-${Math.random().toString(36).slice(2)}.mp4`);
      await writeFile(fixture, content);
      const { graph, cfg, sessionId, llm } = await setup({ fixture });
      await graph.invoke({ sessionId }, cfg);
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "We couldn't read this video file." });
      expect((await graph.getState(cfg)).next).toEqual([]);
      expect(llm.calls.length).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

const ONE_TOPIC = [{ title: "Interview", startMs: 0, endMs: 100_000 }];

describe("analysis", () => {
  it("graph runs to ready and stores one complete version", async () => {
    const { graph, cfg, sessionId, llm } = await setup({
      context: [sufficientDraft()],
      analysis: analysisResponses({ topics: ONE_TOPIC }),
    });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100, profile: "interview" });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(modelCalls(llm).map((c) => c.name)).toEqual([
      "context_card", "topics", "moments", "punchlines", "briefing", "checks", "checks", "checks",
    ]);
    const bundle = (await getCurrentAnalysis(db, sessionId))!;
    expect(bundle.version).toMatchObject({ version: 1, status: "complete", reason: "initial", profile: "interview" });
    expect(bundle.topics.map((t) => t.title)).toEqual(["Interview"]);
    expect(bundle.moments.map((m) => m.granularity).sort()).toEqual(["exchange", "passage", "punchline"]);
    expect(bundle.briefing!.lead).toHaveLength(1);
    // Real ffmpeg: every top highlight has a thumbnail file next to the session's video.
    for (const m of bundle.moments) {
      expect(m.checks).not.toBeNull();
      expect(m.thumbKey).toBe(`${sessionId}/thumbs/${m.id}.jpg`);
      expect(await exists(storage.resolve(m.thumbKey!))).toBe(true);
    }
  });

  it("index node indexes the transcript into the session's collection", async () => {
    const { graph, cfg, sessionId } = await setup({ context: [sufficientDraft()], analysis: analysisResponses({ topics: ONE_TOPIC }) });
    await graph.invoke({ sessionId }, cfg);
    const col = await testChroma.getCollection({ name: collectionName(sessionId) });
    expect(await col.count()).toBeGreaterThan(0);
    await deleteSessionIndex(testChroma, sessionId);
  });

  it("index node failure does not fail the session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const search = { chroma: testChroma, embedder: { embed: async () => Promise.reject(new Error("model download failed")) } };
      const { graph, cfg, sessionId } = await setup({ context: [sufficientDraft()], analysis: analysisResponses({ topics: ONE_TOPIC }), search });
      await graph.invoke({ sessionId }, cfg);
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("a duplicate start after ready is a no-op", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { graph, cfg, sessionId, llm, deps } = await setup({
        context: [sufficientDraft()],
        analysis: analysisResponses({ topics: ONE_TOPIC, runs: 2 }),
      });
      await graph.invoke({ sessionId }, cfg);
      expect((await getSession(db, sessionId))!.stage).toBe("ready");
      const calls = modelCalls(llm).length;
      const ctx: JobContext = { db, deps, graph };
      await handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 });
      expect(modelCalls(llm)).toHaveLength(calls);
      expect(await listAnalysisVersions(db, sessionId)).toHaveLength(1);
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    } finally {
      log.mockRestore();
    }
  });
});

describe("crash and resume", () => {
  it("a retried start job resumes from the checkpoint without re-running finished nodes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let transcribeCalls = 0;
      const flaky: Transcriber = {
        transcribe: async () => {
          if (++transcribeCalls === 1) throw new Error("socket hang up"); // the worker "crashes" mid-transcription
          return transcript;
        },
      };
      const extracted: string[] = [];
      const counting = {
        ...media,
        extractAudio: async (input: string, output: string) => {
          extracted.push(output);
          return media.extractAudio(input, output);
        },
      };
      const { graph, cfg, sessionId, llm, deps } = await setup({
        transcriber: flaky,
        media: counting,
        context: [draft()],
      });
      const ctx: JobContext = { db, deps, graph };

      // First attempt fails in transcribe: not final, so the job is retried and the stage is left as it was.
      await expect(handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 })).rejects.toThrow("socket hang up");
      expect((await getSession(db, sessionId))!.stage).toBe("transcribing");
      expect((await graph.getState(cfg)).next).toEqual(["transcribe"]);

      // pg-boss retries the job: the run continues from the checkpoint.
      await handleStart(ctx, { sessionId }, { retryCount: 1, retryLimit: 2 });
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context", progress: 55 });
      expect((await graph.getState(cfg)).next).toEqual(["ask_context"]);
      expect(extracted).toHaveLength(1); // ingest ran once
      expect(transcribeCalls).toBe(2);
      expect(modelCalls(llm).map((c) => c.name)).toEqual(["context_card"]);

      // A duplicate start job for the same session (e.g. redelivered after the pause) changes nothing.
      await handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 });
      expect(modelCalls(llm)).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("crash/resume does not duplicate the analysis", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // writeBriefing degrades on a model error, so the "crash" is the worker dying while it saves the briefing.
      const { graph, cfg, sessionId, llm, deps, contextCalls } = await setup({
        context: [sufficientDraft()],
        analysis: analysisResponses({ topics: ONE_TOPIC, runs: 2 }),
        db: crashOnInsert(db, "briefings"),
      });
      const ctx: JobContext = { db, deps, graph };

      await expect(handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 })).rejects.toThrow("worker crashed");
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "writing_briefing", progress: 92 });
      expect((await graph.getState(cfg)).next).toEqual(["analyze"]);
      // The unfinished version stays running so the retry reuses its number.
      expect((await listAnalysisVersions(db, sessionId)).map((v) => [v.version, v.status])).toEqual([[1, "running"]]);
      expect(await getCurrentAnalysis(db, sessionId)).toBeNull();

      await handleStart(ctx, { sessionId }, { retryCount: 1, retryLimit: 2 });
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
      expect((await listAnalysisVersions(db, sessionId)).map((v) => [v.version, v.status, v.isCurrent])).toEqual([[1, "complete", true]]);
      const bundle = (await getCurrentAnalysis(db, sessionId))!;
      expect(bundle.topics).toHaveLength(1);
      expect(bundle.moments.map((m) => m.granularity).sort()).toEqual(["exchange", "passage", "punchline"]);
      expect(bundle.briefing!.lead).toHaveLength(1);
      expect(contextCalls()).toHaveLength(1); // the context step was not re-run
      expect(llm.calls.filter((c) => c.name === "topics")).toHaveLength(2); // the analysis node was
    } finally {
      log.mockRestore();
    }
  });
});

describe("match_record", () => {
  const record: RecordRef = { chamber: "senado", date: FIXTURE_DATE, sessionCode: null, url: "https://example/record" };
  const recordRows = async (id: string) => (await listAttributions(db, id)).filter((a) => a.source === "record" && a.supersededAt === null);

  it("graph: name_speakers runs the record step when a record is linked at upload (matched before the context pause)", async () => {
    const { f } = fakeSenadoFetch();
    const { graph, cfg, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f });
    await graph.invoke({ sessionId }, cfg);
    // Paused for context, and the official names are already there.
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "matched" });
    const rows = await recordRows(sessionId);
    expect(rows.map((r) => r.speakerId).sort()).toEqual(["A", "B", "C", "D", "E"]);
    const persons = await getPersons(db, rows.map((r) => r.personId!));
    expect(persons.every((p) => p.kind === "official")).toBe(true);
  });

  it("a record that can't be fetched never fails the session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { f } = fakeSenadoFetch({ list: () => new Response("boom", { status: 503 }) });
    const { graph, cfg, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" }); // went on to the context check
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "failed", error: "The Senado record couldn't be fetched. Please try again." });
    log.mockRestore();
  });

  it("a transient record failure hands the row back to session.names and the graph goes on", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const enqueueNames = vi.fn(async (_id: string) => {});
    const { f } = fakeSenadoFetch({ list: () => new Response("boom", { status: 503 }) });
    const { graph, cfg, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f, enqueueNames });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "pending", error: null });
    expect(enqueueNames).toHaveBeenCalledExactlyOnceWith(sessionId);
    log.mockRestore();
  });

  it("a transient record failure whose job can't be queued fails the row as before", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const enqueueNames = vi.fn(async () => { throw new Error("queue down"); });
    const { f } = fakeSenadoFetch({ list: () => new Response("boom", { status: 503 }) });
    const { graph, cfg, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f, enqueueNames });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "failed", error: "The Senado record couldn't be fetched. Please try again." });
    log.mockRestore();
  });

  it("a record row left running by a crashed attempt is taken over and matched", async () => {
    const { f } = fakeSenadoFetch();
    const { graph, cfg, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f });
    await claimRecordFetch(db, sessionId); // the crashed attempt's claim
    expect((await getSessionRecord(db, sessionId))?.status).toBe("running");
    await graph.invoke({ sessionId }, cfg);
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "matched" });
    expect(await recordRows(sessionId)).toHaveLength(5);
  });

  it("the raw record payload survives name_speakers' frame clean-up", async () => {
    const { f } = fakeSenadoFetch();
    const { graph, cfg, sessionId, resume } = await setup({
      context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f,
      analysis: { ...emptyAnalysisResponses(), captions: Array.from({ length: 30 }, () => captionOf("Fulano Quimby", "PL")) },
    });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "skip" }); // name_speakers runs, then the analysis
    const rec = (await getSessionRecord(db, sessionId))!;
    expect(rec).toMatchObject({ status: "matched", rawKey: `${sessionId}/names/record.json` });
    expect(await exists(storage.resolve(rec.rawKey!))).toBe(true);
  });

  it("without a linked record the step does nothing", async () => {
    const { f, calls } = fakeSenadoFetch();
    const { graph, cfg, sessionId } = await setup({ context: [sufficientDraft()], fetch: f });
    await graph.invoke({ sessionId }, cfg);
    expect(calls).toEqual([]);
    expect(await getSessionRecord(db, sessionId)).toBeNull();
  });
});

describe("name_speakers", () => {
  const captionRows = async (sessionId: string) =>
    (await listAttributions(db, sessionId)).filter((a) => a.source === "caption" && a.supersededAt === null);
  const withCaptions = (captions: unknown[]) => ({ ...emptyAnalysisResponses(), captions });
  const unique = () => `Zeno${Math.random().toString(36).slice(2, 8)}`;

  it("graph: name_speakers writes caption proposals and is idempotent", async () => {
    const first = unique();
    const name = `${first} Quimby`;
    const { graph, cfg, sessionId, deps, llm } = await setup({
      context: [sufficientDraft()],
      analysis: withCaptions(Array.from({ length: 4 }, () => captionOf(name, "PL"))),
    });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
    expect(llm.calls.filter((c) => c.name === "captions")).toMatchObject([{ model: "fast", images: 1 }, { model: "fast", images: 1 }]);
    const [row, ...rest] = await captionRows(sessionId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      speakerId: "A", startMs: null, endMs: null, status: "proposed", confidence: 1, createdBy: "caption",
      evidence: { kind: "caption", frameKey: `${sessionId}/names/A-1000.jpg`, text: name.toUpperCase(), atMs: 1000 },
    });
    expect((await getPersons(db, [row!.personId!]))[0]).toMatchObject({ displayName: name, kind: "custom" });
    expect(await exists(storage.resolve(`${sessionId}/names/A-1000.jpg`))).toBe(true);

    await nameSpeakersNode(deps)({ sessionId }); // a re-run after a crash
    const again = await captionRows(sessionId);
    expect(again).toHaveLength(1);
    expect(again[0]!.personId).toBe(row!.personId);
  });

  it("a short caption reuses the person already proposed for the same voice", async () => {
    const first = unique();
    const { sessionId, deps } = await setup({ analysis: withCaptions([captionOf(first), captionOf(first)]) });
    const full = await createCustomPerson(db, { displayName: `${first} Quimby`, createdBy: "owner" });
    // The transcript named the voice before the captions were read (e.g. a re-run of the step).
    await saveTranscript(db, sessionId, transcript);
    await replaceAiAttributions(db, sessionId, "transcript", [
      { speakerId: "A", startMs: null, endMs: null, personId: full.id, status: "proposed", confidence: 0.7, evidence: { kind: "quote", quote: "x" } },
    ]);
    await nameSpeakersNode(deps)({ sessionId });
    expect((await captionRows(sessionId)).map((r) => r.personId)).toEqual([full.id]);
  });

  it("graph: audio-only or a deleted original skips captions", async () => {
    const audio = await setup({ fixture: AUDIO, audioOnlyAck: true, context: [sufficientDraft()] });
    await audio.graph.invoke({ sessionId: audio.sessionId }, audio.cfg);
    expect(audio.llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await captionRows(audio.sessionId)).toEqual([]);

    const gone = await setup({});
    await saveTranscript(db, gone.sessionId, transcript);
    await updateSession(db, gone.sessionId, { videoDeletedAt: new Date() });
    await nameSpeakersNode(gone.deps)({ sessionId: gone.sessionId });
    const missing = await setup({});
    await saveTranscript(db, missing.sessionId, transcript);
    await rm(storage.resolve(`${missing.sessionId}/original.mp4`));
    await nameSpeakersNode(missing.deps)({ sessionId: missing.sessionId });
    expect(gone.llm.calls.length + missing.llm.calls.length).toBe(0);
  });

  it("graph: a caption failure doesn't fail the session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const boom = () => {
        throw new Error("vision is down");
      };
      const { graph, cfg, sessionId } = await setup({ context: [sufficientDraft()], analysis: withCaptions(Array.from({ length: 4 }, () => boom)) });
      await graph.invoke({ sessionId }, cfg);
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", error: null });
      expect(await captionRows(sessionId)).toEqual([]);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("graph: a trial session reads no captions", async () => {
    const first = unique();
    const trial = { ...sufficientDraft(), profile: { value: "trial" as const, confidence: 0.9, evidence: "Sentence number 2." } };
    const { graph, cfg, sessionId, llm } = await setup({ context: [trial], analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", error: null });
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await captionRows(sessionId)).toEqual([]);
  });

  it("graph: a profile set to trial at the context check reads no captions", async () => {
    const first = unique();
    const { graph, cfg, sessionId, llm, resume } = await setup({ context: [draft(), draft()], analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    await resume({ action: "continue", answers: [], cardEdits: { profile: "trial", dateOrYear: "2026" } });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", error: null });
    expect((await getContextCard(db, sessionId))!.card.profile.value).toBe("trial");
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await captionRows(sessionId)).toEqual([]);
  });

  it("graph: Skip keeps a profile set to trial at the context check (no captions, analysed as trial)", async () => {
    const first = unique();
    const { graph, cfg, sessionId, llm, resume } = await setup({ context: [draft()], analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "skip", cardEdits: { profile: "trial" } });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", error: null, profile: "trial" });
    expect((await getContextCard(db, sessionId))!.card.profile.value).toBe("trial");
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await getCurrentAnalysis(db, sessionId)).toMatchObject({ version: { profile: "trial" } });
  });

  it("graph: captions run after the context check", async () => {
    const first = unique();
    const { graph, cfg, sessionId, llm, resume } = await setup({ context: [draft()], analysis: withCaptions(Array.from({ length: 4 }, () => captionOf(first))) });
    await graph.invoke({ sessionId }, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await captionRows(sessionId)).toEqual([]);
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
    expect(llm.calls.filter((c) => c.name === "captions").length).toBeGreaterThan(0);
    expect(await captionRows(sessionId)).toHaveLength(1);
  });

  it("an old checkpoint at name_speakers (no context card yet) still gets the context check", async () => {
    const { graph, cfg, sessionId, resume } = await setup({ context: [draft()], analysis: withCaptions([]) });
    await updateSession(db, sessionId, { hasVideo: true, proxyKey: `${sessionId}/proxy.mp4` }); // an old session: its copy was made at ingest
    await saveTranscript(db, sessionId, transcript);
    // The state the old graph left: name_speakers done, no context card.
    await graph.updateState(cfg, { sessionId }, "name_speakers");
    expect((await graph.getState(cfg)).next).toEqual(["understand_context"]);
    await graph.invoke(null, cfg);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect((await graph.getState(cfg)).next).toEqual(["ask_context"]);
    expect(await getContextCard(db, sessionId)).not.toBeNull();
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
  });

  it("a missing API key escapes the node (the job fails the session, Ruling R8)", async () => {
    const missing = () => {
      throw new MissingApiKeyError("OPENROUTER_API_KEY");
    };
    const { graph, cfg, sessionId } = await setup({ context: [sufficientDraft()], analysis: withCaptions([missing, missing]) });
    await expect(graph.invoke({ sessionId }, cfg)).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("a human-rejected caption row survives a re-run and that person is not proposed again", async () => {
    const first = unique();
    const { sessionId, deps } = await setup({ analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await saveTranscript(db, sessionId, transcript);
    const p = await createCustomPerson(db, { displayName: first, createdBy: "caption" });
    await replaceAiAttributions(db, sessionId, "caption", [
      { speakerId: "A", startMs: null, endMs: null, personId: p.id, status: "rejected", confidence: 1, evidence: { kind: "caption", frameKey: "k", text: "t", atMs: 1 } },
    ]);
    await nameSpeakersNode(deps)({ sessionId });
    expect((await captionRows(sessionId)).map((r) => [r.personId, r.status])).toEqual([[p.id, "rejected"]]);
  });

  it("a voice a human confirmed or made anonymous gets no caption row", async () => {
    const first = unique();
    const { sessionId, deps } = await setup({ analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await saveTranscript(db, sessionId, transcript);
    const p = await createCustomPerson(db, { displayName: unique(), createdBy: "owner" });
    await setHumanAttribution(db, { sessionId, speakerId: "A", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
    await nameSpeakersNode(deps)({ sessionId });
    expect(await captionRows(sessionId)).toEqual([]);

    const anon = await setup({ analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await saveTranscript(db, anon.sessionId, transcript);
    await setHumanAttribution(db, { sessionId: anon.sessionId, speakerId: "A", startMs: null, endMs: null, personId: null, ownerId: "owner" });
    await nameSpeakersNode(anon.deps)({ sessionId: anon.sessionId });
    expect(await captionRows(anon.sessionId)).toEqual([]);
  });

  it("one failing frame read doesn't drop its voice", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = unique();
      const boom = () => {
        throw new Error("one bad read");
      };
      // Voice A has two long turns (4 frames); B only a short interjection between them.
      const w = (speaker: string, startMs: number, n: number): Word[] =>
        Array.from({ length: n }, (_, i) => ({ text: "w", startMs: startMs + i * 1000, endMs: startMs + i * 1000 + 900, speaker, confidence: 0.9 }));
      const longer: Transcript = { ...transcript, words: [...w("A", 0, 10), ...w("B", 10_000, 2), ...w("A", 12_000, 13)] };
      const { sessionId, deps } = await setup({ transcript: longer, analysis: withCaptions([boom, captionOf(first), captionOf(first), captionOf(first)]) });
      await saveTranscript(db, sessionId, longer);
      await nameSpeakersNode(deps)({ sessionId });
      const rows = await captionRows(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ speakerId: "A", status: "proposed", confidence: 1 });
    } finally {
      log.mockRestore();
    }
  });

  /** The speaker says "<first> Quimby" in sentence 1, so the context agent may ground a name in it. */
  const saidName = (first: string): Transcript => ({
    ...transcript,
    words: mkWords(33).map((w, i) => (i === 4 ? { ...w, text: first } : i === 5 ? { ...w, text: "Quimby." } : w)),
  });
  const namedDraft = (first: string, name: string): ContextCard => ({
    ...draft(),
    participants: [{ speakerId: "A", name: fact(name, "video", `Sentence ${first} Quimby.`), role: none, affiliation: none }],
  });
  const resolveA = async (sessionId: string) => personAt((await listAttributions(db, sessionId)).filter((a) => a.supersededAt === null), "A", 0);

  it("real order (context first, captions second): a short caption reuses the fuller context person (no conflict)", async () => {
    const first = unique();
    const { graph, cfg, sessionId, resume } = await setup({
      transcript: saidName(first),
      context: [namedDraft(first, `${first} Quimby`)],
      analysis: withCaptions([captionOf(first.toUpperCase()), captionOf(first.toUpperCase())]),
    });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "skip" }); // the pause comes first; captions are read after it
    const atts = (await listAttributions(db, sessionId)).filter((a) => a.supersededAt === null);
    const caption = atts.find((a) => a.source === "caption")!;
    const context = atts.find((a) => a.source === "transcript")!;
    expect(caption.personId).toBe(context.personId);
    expect(await resolveA(sessionId)).toMatchObject({ kind: "named", personId: context.personId });
    expect((await getPersons(db, [context.personId!]))[0]!.displayName).toBe(`${first} Quimby`);
    expect(caption.evidence).toMatchObject({ kind: "caption", frameKey: `${sessionId}/names/A-1000.jpg` });
  });

  it("real order, mirrored: a full caption name is reused for a short context name (the context row follows it)", async () => {
    const first = unique();
    const { graph, cfg, sessionId, resume } = await setup({
      transcript: saidName(first),
      context: [namedDraft(first, first)],
      analysis: withCaptions([captionOf(`${first} Quimby`), captionOf(`${first} Quimby`)]),
    });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "skip" }); // the pause comes first; captions are read after it
    const atts = (await listAttributions(db, sessionId)).filter((a) => a.supersededAt === null);
    const caption = atts.find((a) => a.source === "caption")!;
    expect(atts.find((a) => a.source === "transcript")!.personId).toBe(caption.personId);
    expect(await resolveA(sessionId)).toMatchObject({ kind: "named", personId: caption.personId });
  });

  it("keeps only the frames a caption row points to as evidence", async () => {
    const first = unique();
    const { sessionId, deps } = await setup({ analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await saveTranscript(db, sessionId, transcript);
    await writeFile(storage.resolve(`${sessionId}/names/stray.jpg`), "x");
    await nameSpeakersNode(deps)({ sessionId });
    expect((await readdir(path.dirname(storage.resolve(`${sessionId}/names/x`)))).sort()).toEqual(["A-1000.jpg"]);
  });

  it("a re-run where no frame could be read keeps the earlier proposals", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = unique();
      const boom = () => {
        throw new Error("vision is down");
      };
      const { sessionId, deps } = await setup({ analysis: withCaptions([captionOf(first), captionOf(first), boom, boom]) });
      await saveTranscript(db, sessionId, transcript);
      await nameSpeakersNode(deps)({ sessionId });
      const before = await captionRows(sessionId);
      expect(before).toHaveLength(1);
      await nameSpeakersNode(deps)({ sessionId });
      expect((await captionRows(sessionId)).map((r) => r.id)).toEqual(before.map((r) => r.id));
      const { frameKey } = before[0]!.evidence as { frameKey: string };
      expect(await exists(storage.resolve(frameKey))).toBe(true); // the kept row's evidence frame survives the failed re-run
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^captions: 2 of 2 frames failed \(first: vision is down\)/));
    } finally {
      log.mockRestore();
    }
  });
});
