import { access, copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChromaClient } from "chromadb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  acceptSuggestedRecord,
  suggestRecordRow,
  listAnalysisVersions,
  listAttributions,
  replaceAiAttributions,
  saveTranscript,
  createCustomPerson,
  setHumanAttribution,
  updateSession,
  getPipelineRun,
  advancePipelineRun,
  deletePipelineRun,
  setStage,
  transitionStage,
  claimProxy,
  failProxy,
  sessionRecords,
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
import { STEPS, runPipeline, type PipelineDeps } from "./run.js";
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
  root = await mkdtemp(path.join(os.tmpdir(), "digestor-run-"));
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
  /** The pipeline's way to send `session.names` (a transient record failure hands the row back to the job). */
  enqueueNames?: PipelineDeps["enqueueNames"];
  /** The pipeline's way to request the preview copy; default: the copy is made at once, as the job would. */
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
  const start = () => runPipeline(deps, session.id);
  /** The answer as the web's context route sends it: the stage leaves the pause first, then `session.resume` runs. */
  const resume = async (payload: ResumePayload) => {
    const next = payload.action === "continue" ? { stage: "understanding", progress: 55 } as const : { stage: "naming_speakers", progress: 60 } as const;
    await transitionStage(db, session.id, "awaiting_context", next.stage, next.progress);
    return runPipeline(deps, session.id, { resume: payload });
  };
  const nextStep = async () => (await getPipelineRun(db, session.id))?.nextStep;
  /** Paused at the context check: the run waits at ask_context and the session shows the pause. */
  const paused = async () => (await nextStep()) === "ask_context" && (await getSession(db, session.id))?.stage === "awaiting_context";
  return { sessionId: session.id, llm, contextCalls, deps, start, resume, nextStep, paused };
}

/** A database whose inserts into `session_records` throw (the suggester's write). */
function failingSuggestDb(): Db {
  return new Proxy(db, {
    get(obj, prop, receiver) {
      if (prop === "insert") {
        return (t: Parameters<Db["insert"]>[0]) => {
          if (t === sessionRecords) throw new Error("suggest write failed");
          return obj.insert(t);
        };
      }
      const v: unknown = Reflect.get(obj, prop, receiver);
      return typeof v === "function" ? v.bind(obj) : v;
    },
  });
}

const youtubeStub =
  (metadata: YouTubeMetadata): typeof downloadYouTube =>
  async (_url, outPathNoExt) => {
    await copyFile(LONG, `${outPathNoExt}.mp4`);
    return { videoPath: `${outPathNoExt}.mp4`, metadata };
  };

describe("pipeline", () => {
  // The runner logs "ignoring start" / "waiting at the context check" lines that these tests trigger on purpose.
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("pauses for context when the date is missing", async () => {
    const enqueueProxy = vi.fn(async (_id: string) => {});
    const { start, sessionId, llm, nextStep, paused } = await setup({ context: [draft()], enqueueProxy });
    expect(await start()).toBe("paused");
    expect(await nextStep()).toBe("ask_context");
    expect(await paused()).toBe(true);

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
    const { start, sessionId } = await setup({ context: [draft()], media: { ...media, makeProxy }, enqueueProxy });
    await start();
    expect(await getTranscript(db, sessionId)).not.toBeNull();
    expect(makeProxy).not.toHaveBeenCalled();
    expect(enqueueProxy).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(await getSession(db, sessionId)).toMatchObject({ proxyStatus: "pending", proxyKey: null });
  });

  it("a failed send of the copy's job throws, so the node is retried", async () => {
    const enqueueProxy = vi.fn(async () => { throw new Error("queue down"); });
    const { start, sessionId } = await setup({ context: [draft()], enqueueProxy });
    await expect(start()).rejects.toThrow("queue down");
    expect(await getTranscript(db, sessionId)).toBeNull();
  });

  it("the context check pauses with the copy still pending; the analysis then waits for it", async () => {
    const enqueueProxy = vi.fn(async (_id: string) => {});
    const { start, sessionId, resume } = await setup({ context: [draft()], enqueueProxy });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context", proxyStatus: "pending", proxyKey: null });
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "preparing_preview", progress: 96, profile: "interview" });
    expect(await getCurrentAnalysis(db, sessionId)).not.toBeNull();
    expect((await getSession(db, sessionId))!.audioKey).toBe(`${sessionId}/audio.mp3`); // still needed until ready
    await runProxy({ db, storage, media }, sessionId); // the job finishes last and closes it
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100, proxyStatus: "done", proxyKey: `${sessionId}/proxy.mp4`, audioKey: null });
    await expect(access(storage.resolve(`${sessionId}/audio.mp3`))).rejects.toThrow();
  });

  it("a copy that failed during the context pause fails the session before the paid analysis", async () => {
    const enqueueProxy = vi.fn(async (_id: string) => {});
    const { start, sessionId, llm, resume } = await setup({ context: [draft()], enqueueProxy });
    await start();
    await claimProxy(db, sessionId);
    await failProxy(db, sessionId); // the job's last attempt (or the sweep) gave up meanwhile
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: PREVIEW_FAILED });
    expect(llm.calls.filter((c) => c.name !== "context_card" && c.name !== "captions")).toHaveLength(0);
    expect(await getCurrentAnalysis(db, sessionId)).toBeNull();
  });

  it("re-running the analysis step on a ready session leaves it ready and untouched", async () => {
    const { start, sessionId, deps } = await setup({ context: [sufficientDraft()] });
    await start();
    const before = await getSession(db, sessionId);
    expect(before).toMatchObject({ stage: "ready" });
    await STEPS.analyze(deps, (await getPipelineRun(db, sessionId))!); // a replay after a crash before the run advanced
    const after = await getSession(db, sessionId);
    expect(after).toMatchObject({ stage: "ready", progress: 100 });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("re-running the analysis step on a ready session releases audio.mp3 a crash left behind", async () => {
    const { start, sessionId, deps } = await setup({ context: [sufficientDraft()] });
    await start();
    // A crash between closing the join and releasing the audio: the session is ready but still has audio.mp3.
    await writeFile(storage.resolve(`${sessionId}/audio.mp3`), "audio");
    await updateSession(db, sessionId, { audioKey: `${sessionId}/audio.mp3` });
    await STEPS.analyze(deps, (await getPipelineRun(db, sessionId))!);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", audioKey: null });
    await expect(access(storage.resolve(`${sessionId}/audio.mp3`))).rejects.toThrow();
  });

  it("skip goes on to the analysis and ready after the single context pause", async () => {
    const { start, sessionId, contextCalls, resume, nextStep } = await setup({ context: [draft()] });
    await start();
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100, audioKey: null });
    await expect(access(storage.resolve(`${sessionId}/audio.mp3`))).rejects.toThrow();
    expect(await nextStep()).toBe("done");
    expect(contextCalls()).toHaveLength(1); // no second context round
    expect(await getCurrentAnalysis(db, sessionId)).toMatchObject({ version: { version: 1, reason: "initial", profile: "interview" } });
  });

  it("asks one follow-up round with the new questions, then finishes (never a third round)", async () => {
    const { start, sessionId, llm, contextCalls, resume, nextStep, paused } = await setup({ context: [draft(), draft(), draft()] });
    await start();
    await resume({
      action: "continue",
      answers: [
        { questionId: "date", answer: "Maybe last spring" },
        { questionId: "unknown", answer: "ignored answer" },
      ],
      cardEdits: { title: "Budget hearing", profile: "supreme_court", participants: [{ speakerId: "A", name: "Maria Silva" }] },
    });
    // Still insufficient after round 1's answers: the follow-up round pauses with its own questions.
    expect(await paused()).toBe(true);
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
    expect(await nextStep()).toBe("done");
    expect(contextCalls()).toHaveLength(3);
    expect(modelCalls(llm)[2]!.user).toContain("A: Maybe last spring");
    expect(modelCalls(llm)[2]!.user).toContain("Q: When was this recorded or first aired?\nA: Sometime in 2025");
    expect((await getContextCard(db, sessionId))!.card.sufficient).toBe(false);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
  });

  it("a confirmed human name survives a second context round", async () => {
    const { start, sessionId, llm, resume } = await setup({ context: [draft(), draft(), draft()] });
    await start();
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
    const { start, sessionId, llm, resume } = await setup({ context: [draft()] });
    await start();
    const p = await createCustomPerson(db, { displayName: "Renomeada Na Pausa", createdBy: "owner" });
    await setHumanAttribution(db, { sessionId, speakerId: "A", startMs: null, endMs: null, personId: p.id, ownerId: "owner" });
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
    const analysis = modelCalls(llm).filter((c) => c.name !== "context_card");
    expect(analysis.length).toBeGreaterThan(0);
    expect(analysis.every((c) => c.system.includes("Renomeada Na Pausa"))).toBe(true);
  });

  it("skipping the follow-up round goes on to ready", async () => {
    const { start, sessionId, contextCalls, resume, paused } = await setup({ context: [draft(), draft()] });
    await start();
    await resume({ action: "continue", answers: [{ questionId: "date", answer: "no idea" }], cardEdits: {} });
    expect(await paused()).toBe(true);
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    expect(contextCalls()).toHaveLength(2);
  });

  it("sufficient context never pauses for context", async () => {
    const { start, sessionId } = await setup({ context: [sufficientDraft()] });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    expect((await getContextCard(db, sessionId))!).toMatchObject({ round: 1, card: { sufficient: true } });
  });

  it("fails cleanly on a video without audio", async () => {
    const { start, sessionId, llm } = await setup({ fixture: SILENT });
    expect(await start()).toBe("stopped");
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "This video has no audio track." });
    expect(await start()).toBe("ignored"); // nothing left to run
    expect(llm.calls.length).toBe(0);
  });

  it("a file without a picture and without acknowledgement (a video container) goes on as audio-only", async () => {
    const { start, sessionId, paused } = await setup({ fixture: AUDIO, context: [draft()] });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ hasVideo: false, audioOnlyAck: false, error: null, stage: "awaiting_context", proxyKey: `${sessionId}/proxy.mp4` });
    expect(await paused()).toBe(true);
  });

  it("with acknowledgement continues and sets hasVideo false", async () => {
    const { start, sessionId, paused } = await setup({ fixture: AUDIO, audioOnlyAck: true, context: [draft()] });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ hasVideo: false, stage: "awaiting_context", proxyKey: `${sessionId}/proxy.mp4` });
    expect(await paused()).toBe(true);
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
    const { start, sessionId, llm } = await setup({
      youtube: youtubeStub(metadata),
      context: [llmDraft],
    });
    await start();
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

  describe("record suggestion from the YouTube details", () => {
    const meta = (over: Partial<YouTubeMetadata> = {}): YouTubeMetadata => ({
      title: "92. Sitzung vom 09.09.2026. TOP Epl 04: Bundeskanzler und Bundeskanzleramt",
      description: "",
      channel: "Deutscher Bundestag",
      uploadDate: "2026-09-10",
      webpageUrl: "https://www.youtube.com/watch?v=abc",
      durationS: 100,
      ...over,
    });
    const bundestag: RecordRef = { chamber: "bundestag", period: 21, sitting: 92, date: "2026-09-09", url: "https://www.bundestag.de/services/opendata" };

    it("a Bundestag title gets a suggested row, and the analysis goes on", async () => {
      const { start, sessionId } = await setup({ youtube: youtubeStub(meta()), context: [draft()] });
      await start();
      expect(await getSessionRecord(db, sessionId)).toMatchObject({ chamber: "bundestag", status: "suggested", ref: bundestag });
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    });

    it("a video that points to no sitting gets none", async () => {
      const { start, sessionId } = await setup({ youtube: youtubeStub(meta({ channel: "phoenix", title: "US-Zwischenwahlen | 04.11.26" })), context: [draft()] });
      await start();
      expect(await getSessionRecord(db, sessionId)).toBeNull();
    });

    it("a record linked at upload keeps its row untouched", async () => {
      const linked: RecordRef = { chamber: "senado", date: FIXTURE_DATE, sessionCode: null, url: "https://example/record" };
      const { f } = fakeSenadoFetch();
      const { start, sessionId } = await setup({ youtube: youtubeStub(meta()), context: [draft()], transcript: transcriptOfSpeeches(), record: linked, fetch: f });
      await start();
      expect(await getSessionRecord(db, sessionId)).toMatchObject({ chamber: "senado", status: "matched", ref: linked });
    });

    it("a failing suggester never fails the session", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { start, sessionId } = await setup({ youtube: youtubeStub(meta()), context: [draft()], db: failingSuggestDb() });
      await start();
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
      expect(await getSessionRecord(db, sessionId)).toBeNull();
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });

    it("an uploaded file gets none", async () => {
      const { start, sessionId } = await setup({ context: [draft()] });
      await updateSession(db, sessionId, { title: "92. Sitzung vom 09.09.2026", metadata: { channel: "Deutscher Bundestag", title: "92. Sitzung vom 09.09.2026" } });
      await start();
      expect(await getSessionRecord(db, sessionId)).toBeNull();
    });
  });

  it("youtube download failure ends with the friendly message", async () => {
    const stderr = "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser";
    const { start, sessionId, llm } = await setup({
      youtube: async () => {
        throw new YouTubeDownloadError(mapYtDlpError(stderr), stderr);
      },
    });
    expect(await start()).toBe("stopped");
    const s = (await getSession(db, sessionId))!;
    expect(s.stage).toBe("failed");
    expect(s.error).toContain("upload the file");
    expect(s.error).not.toContain("ERROR:");
    expect(s.originalKey).toBeNull();
    expect(await start()).toBe("ignored"); // nothing left to run
    expect(llm.calls.length).toBe(0);
  });

  it("an unexpected download error ends with the generic message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { start, sessionId, llm } = await setup({
        youtube: async () => {
          throw new Error("ENOENT: no such file or directory, open '/data/x/original.info.json'");
        },
      });
      await start();
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
    const { start, sessionId, llm } = await setup({ transcript: { ...transcript, words: [] } });
    expect(await start()).toBe("stopped");
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "No speech was detected in this video." });
    expect(await start()).toBe("ignored"); // nothing left to run
    expect(llm.calls.length).toBe(0);
  });

  it("AssemblyAI's 'no spoken audio' error ends with the no-speech message, not a transcription failure", async () => {
    // What AssemblyAI answers (status "error") for a file without speech when language_detection is on.
    const silent: Transcriber = {
      transcribe: async () => {
        throw new TranscriptionError("language_detection cannot be performed on files with no spoken audio.");
      },
    };
    const { start, sessionId, llm } = await setup({ transcriber: silent });
    expect(await start()).toBe("stopped");
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "No speech was detected in this video." });
    expect(await start()).toBe("ignored"); // nothing left to run
    expect(llm.calls.length).toBe(0);
  });

  it("other transcription errors still escape the graph", async () => {
    const broken: Transcriber = {
      transcribe: async () => {
        throw new TranscriptionError("Audio file is corrupt");
      },
    };
    const { start, sessionId } = await setup({ transcriber: broken });
    await expect(start()).rejects.toThrow("Audio file is corrupt");
    await expect(start()).rejects.toBeInstanceOf(TranscriptionError); // jobs.ts relies on instanceof
  });

  it("passes the probed duration to the transcriber", async () => {
    const seen: (number | undefined)[] = [];
    const recording: Transcriber = {
      transcribe: async (_p, fallbackDurationMs) => {
        seen.push(fallbackDurationMs);
        return { ...transcript, words: [] };
      },
    };
    const { start, sessionId } = await setup({ transcriber: recording });
    await start();
    expect(seen).toHaveLength(1);
    expect(Math.abs(seen[0]! - 100_000)).toBeLessThan(500);
  });

  it("passes the session's language override to the transcriber, and nothing when there is none", async () => {
    const seen: (string | undefined)[] = [];
    const recording: Transcriber = {
      transcribe: async (_p, _d, opts) => {
        seen.push(opts?.languageCode);
        return { ...transcript, words: [] };
      },
    };
    const a = await setup({ transcriber: recording });
    await updateSession(db, a.sessionId, { languageOverride: "fr" });
    await a.start();
    const b = await setup({ transcriber: recording });
    await b.start();
    expect(seen).toEqual(["fr", undefined]);
  });

  it.each([
    ["a zero-byte file", ""],
    ["a text file renamed to .mp4", "this is not a video"],
  ])("fails cleanly on an unreadable video (%s)", async (_case, content) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fixture = path.join(root, `unreadable-${Math.random().toString(36).slice(2)}.mp4`);
      await writeFile(fixture, content);
      const { start, sessionId, llm } = await setup({ fixture });
      expect(await start()).toBe("stopped");
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "failed", error: "We couldn't read this video file." });
      expect(await start()).toBe("ignored"); // nothing left to run
      expect(llm.calls.length).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

const ONE_TOPIC = [{ title: "Interview", startMs: 0, endMs: 100_000 }];

describe("analysis", () => {
  it("graph runs to ready and stores one complete version", async () => {
    const { start, sessionId, llm, nextStep } = await setup({
      context: [sufficientDraft()],
      analysis: analysisResponses({ topics: ONE_TOPIC }),
    });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100, profile: "interview" });
    expect(await nextStep()).toBe("done");
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
    const { start, sessionId } = await setup({ context: [sufficientDraft()], analysis: analysisResponses({ topics: ONE_TOPIC }) });
    await start();
    const col = await testChroma.getCollection({ name: collectionName(sessionId) });
    expect(await col.count()).toBeGreaterThan(0);
    await deleteSessionIndex(testChroma, sessionId);
  });

  it("index node failure does not fail the session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const search = { chroma: testChroma, embedder: { embed: async () => Promise.reject(new Error("model download failed")) } };
      const { start, sessionId } = await setup({ context: [sufficientDraft()], analysis: analysisResponses({ topics: ONE_TOPIC }), search });
      await start();
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("a duplicate start after ready is a no-op", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { start, sessionId, llm, deps } = await setup({
        context: [sufficientDraft()],
        analysis: analysisResponses({ topics: ONE_TOPIC, runs: 2 }),
      });
      await start();
      expect((await getSession(db, sessionId))!.stage).toBe("ready");
      const calls = modelCalls(llm).length;
      const ctx: JobContext = { db, deps };
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
  it("a retried start job resumes from the stored step without re-running finished steps", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
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
      const { sessionId, llm, deps, nextStep } = await setup({
        transcriber: flaky,
        media: counting,
        context: [draft()],
      });
      const ctx: JobContext = { db, deps };

      // First attempt fails in transcribe: not final, so the job is retried and the stage is left as it was.
      await expect(handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 })).rejects.toThrow("socket hang up");
      expect((await getSession(db, sessionId))!.stage).toBe("transcribing");
      expect(await nextStep()).toBe("transcribe");

      // pg-boss retries the job: the run continues from its stored step.
      await handleStart(ctx, { sessionId }, { retryCount: 1, retryLimit: 2 });
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context", progress: 55 });
      expect(await nextStep()).toBe("ask_context");
      expect(extracted).toHaveLength(1); // ingest ran once
      expect(transcribeCalls).toBe(2);
      expect(modelCalls(llm).map((c) => c.name)).toEqual(["context_card"]);

      // A duplicate start job for the same session (e.g. redelivered after the pause) changes nothing.
      await handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 });
      expect(modelCalls(llm)).toHaveLength(1);
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context", progress: 55 });
      expect(await nextStep()).toBe("ask_context");
    } finally {
      log.mockRestore();
      info.mockRestore();
    }
  });

  it("crash/resume does not duplicate the analysis", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // writeBriefing degrades on a model error, so the "crash" is the worker dying while it saves the briefing.
      const { sessionId, llm, deps, contextCalls, nextStep } = await setup({
        context: [sufficientDraft()],
        analysis: analysisResponses({ topics: ONE_TOPIC, runs: 2 }),
        db: crashOnInsert(db, "briefings"),
      });
      const ctx: JobContext = { db, deps };

      await expect(handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 })).rejects.toThrow("worker crashed");
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "writing_briefing", progress: 92 });
      expect(await nextStep()).toBe("analyze");
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

describe("runner", () => {
  const dateAnswer: ResumePayload = { action: "continue", answers: [{ questionId: "date", answer: "Maybe last spring" }], cardEdits: {} };
  const runOf = async (id: string) => (await getPipelineRun(db, id))!;
  const quiet = () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => (log.mockRestore(), err.mockRestore());
  };

  it("a duplicate start while the web has moved the stage to understanding leaves the stage alone and runs nothing", async () => {
    const restore = quiet();
    try {
      const { start, sessionId, contextCalls, nextStep, deps } = await setup({ context: [draft(), draft()] });
      expect(await start()).toBe("paused");
      expect(await transitionStage(db, sessionId, "awaiting_context", "understanding", 55)).toBe(true); // the web's Continue
      expect(await start()).toBe("paused"); // a redelivered start job
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "understanding", progress: 55 });
      expect(await nextStep()).toBe("ask_context");
      expect(contextCalls()).toHaveLength(1);
      // The resume the web sent is still answered.
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer })).toBe("paused");
      expect(contextCalls()).toHaveLength(2);
      expect((await runOf(sessionId)).answers).toEqual([{ question: "When was this recorded or first aired?", answer: "Maybe last spring" }]);
    } finally {
      restore();
    }
  });

  it("a session failed while understand_context runs ends failed and does not pause or go on", async () => {
    const restore = quiet();
    try {
      let id = "";
      const failMidCall = async () => {
        await setStage(db, id, "failed", 55, "Swept");
        return draft();
      };
      const s = await setup({ context: [failMidCall] });
      id = s.sessionId;
      expect(await s.start()).toBe("stopped");
      expect(await getSession(db, id)).toMatchObject({ stage: "failed", error: "Swept" });
      expect(await s.nextStep()).not.toBe("name_speakers");
      expect(s.contextCalls()).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a runner that loses the compare-and-set stops and writes nothing further", async () => {
    const restore = quiet();
    try {
      let id = "";
      const rival = async () => {
        // Another writer moves the row past understand_context while this runner's call is in flight.
        expect(await advancePipelineRun(db, id, "understand_context", "ask_context", { stage: { stage: "awaiting_context", progress: 55 } })).toBe(true);
        return draft();
      };
      const s = await setup({ context: [rival] });
      id = s.sessionId;
      expect(await s.start()).toBe("stopped");
      expect(await getPipelineRun(db, id)).toMatchObject({ nextStep: "ask_context", round: 0 });
      expect(await getSession(db, id)).toMatchObject({ stage: "awaiting_context", progress: 55 });
      expect(s.contextCalls()).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a retried resume after the answers were applied does not append them again", async () => {
    const restore = quiet();
    try {
      const { start, resume, sessionId, contextCalls, deps, paused } = await setup({ context: [draft(), draft(), draft()] });
      await start();
      expect(await resume(dateAnswer)).toBe("paused"); // round 2 is waiting
      expect(contextCalls()).toHaveLength(2);
      const before = await runOf(sessionId);
      expect(before).toMatchObject({ nextStep: "ask_context", round: 2 });
      expect(before.answers).toHaveLength(1);
      // pg-boss redelivers the same resume job: the new pause is not answered with the old payload.
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer })).toBe("paused");
      expect(contextCalls()).toHaveLength(2); // one context_card call per round
      expect((await runOf(sessionId)).answers).toEqual(before.answers);
      expect(await paused()).toBe(true);
    } finally {
      restore();
    }
  });

  it("a redelivered round-1 resume after round 2 was answered is ignored; round 2's resume applies", async () => {
    const restore = quiet();
    try {
      const { start, resume, sessionId, contextCalls, deps, nextStep } = await setup({ context: [draft(), draft()] });
      await start();
      expect(await resume(dateAnswer)).toBe("paused"); // round 1 applied, round 2 waits
      const before = await runOf(sessionId);
      expect(before).toMatchObject({ nextStep: "ask_context", round: 2 });
      // The journalist already answered round 2 (the web moved the stage on) when round 1's job is redelivered.
      expect(await transitionStage(db, sessionId, "awaiting_context", "naming_speakers", 60)).toBe(true);
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer, round: 1 })).toBe("paused");
      expect(await runOf(sessionId)).toEqual(before);
      expect(await nextStep()).toBe("ask_context");
      expect(contextCalls()).toHaveLength(2);
      expect(await runPipeline(deps, sessionId, { resume: { action: "skip" }, round: 2 })).toBe("done");
    } finally {
      restore();
    }
  });

  it("a round-1 resume retried after a crash inside ask_context still applies", async () => {
    const restore = quiet();
    try {
      const { start, sessionId, contextCalls, deps } = await setup({ context: [draft(), draft()] });
      await start();
      // The first attempt died inside ask_context before its move: the row is still at ask_context, round 1, stage moved by the web.
      expect(await transitionStage(db, sessionId, "awaiting_context", "understanding", 55)).toBe(true);
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer, round: 1 })).toBe("paused");
      expect(contextCalls()).toHaveLength(2);
      expect(await runOf(sessionId)).toMatchObject({ nextStep: "ask_context", round: 2 });
      expect((await runOf(sessionId)).answers).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a resume with the matching round is applied even while the stage is still awaiting_context", async () => {
    const restore = quiet();
    try {
      const { start, sessionId, contextCalls, deps } = await setup({ context: [draft(), draft()] });
      await start();
      expect((await getSession(db, sessionId))!.stage).toBe("awaiting_context"); // a send that committed but threw never moved it on
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer, round: 1 })).toBe("paused");
      expect(contextCalls()).toHaveLength(2);
      expect(await runOf(sessionId)).toMatchObject({ nextStep: "ask_context", round: 2 });
      expect((await runOf(sessionId)).answers).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a resume without a round behaves as before (stage guard)", async () => {
    const restore = quiet();
    try {
      const { start, sessionId, contextCalls, deps } = await setup({ context: [draft(), draft()] });
      await start();
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer })).toBe("paused"); // still awaiting_context: stale
      expect(contextCalls()).toHaveLength(1);
      expect(await transitionStage(db, sessionId, "awaiting_context", "understanding", 55)).toBe(true);
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer })).toBe("paused");
      expect(contextCalls()).toHaveLength(2);
      expect(await runOf(sessionId)).toMatchObject({ round: 2 });
    } finally {
      restore();
    }
  });

  it("a resume retried after a crash in understand_context continues without the payload", async () => {
    const restore = quiet();
    try {
      const crash = () => {
        throw new Error("socket hang up");
      };
      const { start, resume, sessionId, contextCalls, deps, llm, paused } = await setup({ context: [draft(), crash, draft()] });
      await start();
      await expect(resume(dateAnswer)).rejects.toThrow("socket hang up");
      expect(await runOf(sessionId)).toMatchObject({ nextStep: "understand_context", round: 1 });
      expect((await runOf(sessionId)).answers).toHaveLength(1);
      expect(await runPipeline(deps, sessionId, { resume: dateAnswer })).toBe("paused"); // the job's retry
      expect(contextCalls()).toHaveLength(3); // round 1, the crashed call, round 2
      expect((await runOf(sessionId)).answers).toHaveLength(1);
      expect(modelCalls(llm)[2]!.user.match(/A: Maybe last spring/g)).toHaveLength(1);
      expect(await runOf(sessionId)).toMatchObject({ nextStep: "ask_context", round: 2 });
      expect(await paused()).toBe(true);
    } finally {
      restore();
    }
  });

  it("a session left mid-pipeline by the old graph (no run row, stage transcribing) continues from transcribe", async () => {
    const restore = quiet();
    try {
      let transcribeCalls = 0;
      const flaky: Transcriber = {
        transcribe: async () => {
          if (++transcribeCalls === 1) throw new Error("socket hang up");
          return transcript;
        },
      };
      const extracted: string[] = [];
      const counting = { ...media, extractAudio: async (i: string, o: string) => (extracted.push(o), media.extractAudio(i, o)) };
      const { start, sessionId, contextCalls, nextStep } = await setup({ transcriber: flaky, media: counting, context: [draft()] });
      await expect(start()).rejects.toThrow("socket hang up");
      await deletePipelineRun(db, sessionId); // the old graph's checkpoint is gone; the stage is what remains
      expect((await getSession(db, sessionId))!.stage).toBe("transcribing");
      expect(await start()).toBe("paused");
      expect(extracted).toHaveLength(1); // ingest did not run again
      expect(transcribeCalls).toBe(2);
      expect(contextCalls()).toHaveLength(1);
      expect(await nextStep()).toBe("ask_context");
    } finally {
      restore();
    }
  });

  it("a session left mid-pipeline by the old graph (stage awaiting_context) pauses, and a resume continues", async () => {
    const restore = quiet();
    try {
      const { start, resume, sessionId, contextCalls, paused } = await setup({ context: [draft()] });
      await start();
      await deletePipelineRun(db, sessionId);
      expect(await start()).toBe("paused"); // the retried start finds the pause
      expect(await paused()).toBe(true);
      expect(contextCalls()).toHaveLength(1);
      expect((await runOf(sessionId)).round).toBe(1); // the round of the stored card
      expect(await resume({ action: "skip" })).toBe("done");
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    } finally {
      restore();
    }
  });

  it("a session left mid-pipeline by the old graph (no row, web already moved the stage to understanding) a resume applies the answers", async () => {
    const restore = quiet();
    try {
      const { start, resume, sessionId, llm, paused } = await setup({ context: [draft(), draft()] });
      await start();
      await deletePipelineRun(db, sessionId); // paused under LangGraph, answered after the deploy
      expect(await resume(dateAnswer)).toBe("paused");
      expect(modelCalls(llm)[1]!.user).toContain("Q: When was this recorded or first aired?\nA: Maybe last spring");
      expect((await getContextCard(db, sessionId))!.round).toBe(2);
      expect(await paused()).toBe(true);
    } finally {
      restore();
    }
  });

  it("a start job for a ready or failed session is ignored", async () => {
    const restore = quiet();
    try {
      const ready = await setup({ context: [sufficientDraft()] });
      await setStage(db, ready.sessionId, "ready", 100); // finished under the old graph: no run row
      expect(await ready.start()).toBe("ignored");
      expect(await ready.resume({ action: "skip" })).toBe("ignored");
      const failed = await setup({ context: [sufficientDraft()] });
      await setStage(db, failed.sessionId, "failed", 20, "No speech was detected in this video.");
      expect(await failed.start()).toBe("ignored");
      expect(await getPipelineRun(db, failed.sessionId)).toBeNull();
      expect(ready.llm.calls.length + failed.llm.calls.length).toBe(0);
      expect(await getSession(db, ready.sessionId)).toMatchObject({ stage: "ready", progress: 100 });
      expect(await getSession(db, failed.sessionId)).toMatchObject({ stage: "failed", error: "No speech was detected in this video." });
      // A run that finished is not started again either.
      const done = await setup({ context: [sufficientDraft()] });
      expect(await done.start()).toBe("done");
      const calls = done.llm.calls.length;
      expect(await done.start()).toBe("ignored");
      expect(done.llm.calls).toHaveLength(calls);
    } finally {
      restore();
    }
  });
});

describe("match_record", () => {
  const record: RecordRef = { chamber: "senado", date: FIXTURE_DATE, sessionCode: null, url: "https://example/record" };
  const recordRows = async (id: string) => (await listAttributions(db, id)).filter((a) => a.source === "record" && a.supersededAt === null);

  it("graph: name_speakers runs the record step when a record is linked at upload (matched before the context pause)", async () => {
    const { f } = fakeSenadoFetch();
    const { start, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f });
    await start();
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
    const { start, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" }); // went on to the context check
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "failed", error: "The Senado record couldn't be fetched. Please try again." });
    log.mockRestore();
  });

  it("a transient record failure hands the row back to session.names and the graph goes on", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const enqueueNames = vi.fn(async (_id: string) => {});
    const { f } = fakeSenadoFetch({ list: () => new Response("boom", { status: 503 }) });
    const { start, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f, enqueueNames });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "pending", error: null });
    expect(enqueueNames).toHaveBeenCalledExactlyOnceWith(sessionId);
    log.mockRestore();
  });

  it("a transient record failure whose job can't be queued fails the row as before", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const enqueueNames = vi.fn(async () => { throw new Error("queue down"); });
    const { f } = fakeSenadoFetch({ list: () => new Response("boom", { status: 503 }) });
    const { start, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f, enqueueNames });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "failed", error: "The Senado record couldn't be fetched. Please try again." });
    log.mockRestore();
  });

  it("a record row left running by a crashed attempt is taken over and matched", async () => {
    const { f } = fakeSenadoFetch();
    const { start, sessionId } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f });
    await claimRecordFetch(db, sessionId); // the crashed attempt's claim
    expect((await getSessionRecord(db, sessionId))?.status).toBe("running");
    await start();
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "matched" });
    expect(await recordRows(sessionId)).toHaveLength(5);
  });

  it("the raw record payload survives name_speakers' frame clean-up", async () => {
    const { f } = fakeSenadoFetch();
    const { start, sessionId, resume } = await setup({
      context: [draft()], transcript: transcriptOfSpeeches(), record, fetch: f,
      analysis: { ...emptyAnalysisResponses(), captions: Array.from({ length: 30 }, () => captionOf("Fulano Quimby", "PL")) },
    });
    await start();
    await resume({ action: "skip" }); // name_speakers runs, then the analysis
    const rec = (await getSessionRecord(db, sessionId))!;
    expect(rec).toMatchObject({ status: "matched", rawKey: `${sessionId}/names/record.json` });
    expect(await exists(storage.resolve(rec.rawKey!))).toBe(true);
  });

  it("a suggestion accepted at the context check is matched by match_record_late on Continue, before the analysis", async () => {
    const { f } = fakeSenadoFetch();
    const { start, sessionId, resume } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), fetch: f });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(await getSessionRecord(db, sessionId)).toBeNull();
    expect(await suggestRecordRow(db, sessionId, record)).toBe(true);
    expect(await acceptSuggestedRecord(db, sessionId, record)).toBe(true); // "Use this record": pending, no job at the context check
    expect(await recordRows(sessionId)).toHaveLength(0);
    await resume({ action: "skip" });
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "matched" });
    expect((await recordRows(sessionId)).map((r) => r.speakerId).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
  });

  it("a suggestion nobody accepted stays suggested and the graph goes on", async () => {
    const { f, calls } = fakeSenadoFetch();
    const { start, sessionId, resume } = await setup({ context: [draft()], transcript: transcriptOfSpeeches(), fetch: f });
    await start();
    await suggestRecordRow(db, sessionId, record);
    await resume({ action: "skip" });
    expect(calls).toEqual([]);
    expect(await getSessionRecord(db, sessionId)).toMatchObject({ status: "suggested" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
  });

  it("match_record_late with no record is a no-op", async () => {
    const { f, calls } = fakeSenadoFetch();
    const { start, sessionId, resume } = await setup({ context: [draft()], fetch: f });
    await start();
    await resume({ action: "skip" });
    expect(calls).toEqual([]);
    expect(await getSessionRecord(db, sessionId)).toBeNull();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
  });

  it("a session left mid-pipeline by the old graph (no run row, stage naming_speakers) continues from name_speakers", async () => {
    const { start, sessionId, nextStep } = await setup({ context: [draft()] });
    await start();
    // What a LangGraph checkpoint at name_speakers looks like after the deploy: no run row, the stage of that step.
    await deletePipelineRun(db, sessionId);
    await setStage(db, sessionId, "naming_speakers", 60);
    expect(await start()).toBe("done");
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
    expect(await nextStep()).toBe("done");
  });

  it("without a linked record the step does nothing", async () => {
    const { f, calls } = fakeSenadoFetch();
    const { start, sessionId } = await setup({ context: [sufficientDraft()], fetch: f });
    await start();
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
    const { start, sessionId, deps, llm } = await setup({
      context: [sufficientDraft()],
      analysis: withCaptions(Array.from({ length: 4 }, () => captionOf(name, "PL"))),
    });
    await start();
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
    await audio.start();
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
      const { start, sessionId } = await setup({ context: [sufficientDraft()], analysis: withCaptions(Array.from({ length: 4 }, () => boom)) });
      await start();
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
    const { start, sessionId, llm } = await setup({ context: [trial], analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", error: null });
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await captionRows(sessionId)).toEqual([]);
  });

  it("graph: a profile set to trial at the context check reads no captions", async () => {
    const first = unique();
    const { start, sessionId, llm, resume } = await setup({ context: [draft(), draft()], analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    await resume({ action: "continue", answers: [], cardEdits: { profile: "trial", dateOrYear: "2026" } });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", error: null });
    expect((await getContextCard(db, sessionId))!.card.profile.value).toBe("trial");
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await captionRows(sessionId)).toEqual([]);
  });

  it("graph: Skip keeps a profile set to trial at the context check (no captions, analysed as trial)", async () => {
    const first = unique();
    const { start, sessionId, llm, resume } = await setup({ context: [draft()], analysis: withCaptions([captionOf(first), captionOf(first)]) });
    await start();
    await resume({ action: "skip", cardEdits: { profile: "trial" } });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", error: null, profile: "trial" });
    expect((await getContextCard(db, sessionId))!.card.profile.value).toBe("trial");
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await getCurrentAnalysis(db, sessionId)).toMatchObject({ version: { profile: "trial" } });
  });

  it("graph: captions run after the context check", async () => {
    const first = unique();
    const { start, sessionId, llm, resume } = await setup({ context: [draft()], analysis: withCaptions(Array.from({ length: 4 }, () => captionOf(first))) });
    await start();
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_context" });
    expect(llm.calls.filter((c) => c.name === "captions")).toEqual([]);
    expect(await captionRows(sessionId)).toEqual([]);
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready" });
    expect(llm.calls.filter((c) => c.name === "captions").length).toBeGreaterThan(0);
    expect(await captionRows(sessionId)).toHaveLength(1);
  });

  it("a missing API key escapes the node (the job fails the session, Ruling R8)", async () => {
    const missing = () => {
      throw new MissingApiKeyError("OPENROUTER_API_KEY");
    };
    const { start, sessionId } = await setup({ context: [sufficientDraft()], analysis: withCaptions([missing, missing]) });
    await expect(start()).rejects.toBeInstanceOf(MissingApiKeyError);
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
    const { start, sessionId, resume } = await setup({
      transcript: saidName(first),
      context: [namedDraft(first, `${first} Quimby`)],
      analysis: withCaptions([captionOf(first.toUpperCase()), captionOf(first.toUpperCase())]),
    });
    await start();
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
    const { start, sessionId, resume } = await setup({
      transcript: saidName(first),
      context: [namedDraft(first, first)],
      analysis: withCaptions([captionOf(`${first} Quimby`), captionOf(`${first} Quimby`)]),
    });
    await start();
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
