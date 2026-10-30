import { access, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { ContextCard, Fact, ResumePayload, Transcript, Word } from "@digestor/core";
import {
  LocalStorage,
  createDb,
  createSession,
  getContextCard,
  getSession,
  updateSession,
  type Db,
} from "@digestor/core/server";
import * as media from "../media/ffmpeg.js";
import { FakeTranscriber, TranscriptionError, type Transcriber } from "../transcribe/assemblyai.js";
import { handleStart, type JobContext } from "../jobs.js";
import { FakeLLM } from "../llm/structured.js";
import { YouTubeDownloadError, mapYtDlpError, type YouTubeMetadata, type downloadYouTube } from "../youtube/ytdlp.js";
import { buildPipeline, type PipelineDeps } from "./graph.js";

const TMP = fileURLToPath(new URL("../../test/tmp/", import.meta.url));
const LONG = `${TMP}long.mp4`; // 100 s with audio
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
  llm?: unknown[];
  transcript?: Transcript;
  transcriber?: Transcriber;
  fixture?: string;
  youtube?: typeof downloadYouTube;
  media?: PipelineDeps["media"];
};

const notCalled: typeof downloadYouTube = async () => {
  throw new Error("downloadYouTube should not be called");
};

async function setup(o: Setup = {}) {
  const session = o.youtube
    ? await createSession(db, { title: "YouTube video", source: "youtube", sourceUrl: "https://www.youtube.com/watch?v=abc" })
    : await createSession(db, { title: "Upload", source: "upload" });
  if (!o.youtube) {
    const originalKey = storage.key(session.id, "original.mp4");
    await copyFile(o.fixture ?? LONG, storage.resolve(originalKey));
    await updateSession(db, session.id, { originalKey });
  }
  const llm = new FakeLLM(o.llm ?? []);
  const deps: PipelineDeps = {
    db,
    storage,
    transcriber: o.transcriber ?? new FakeTranscriber(o.transcript ?? transcript),
    llm,
    media: o.media ?? media,
    youtube: { downloadYouTube: o.youtube ?? notCalled },
  };
  const graph = buildPipeline(deps, new MemorySaver());
  const cfg = { configurable: { thread_id: session.id } };
  const resume = (payload: ResumePayload) => graph.invoke(new Command({ resume: payload }), cfg);
  const interruptValue = async () => (await graph.getState(cfg)).tasks[0]?.interrupts[0]?.value;
  return { sessionId: session.id, llm, deps, graph, cfg, resume, interruptValue };
}

const youtubeStub =
  (metadata: YouTubeMetadata): typeof downloadYouTube =>
  async (_url, outPathNoExt) => {
    await copyFile(LONG, `${outPathNoExt}.mp4`);
    return { videoPath: `${outPathNoExt}.mp4`, metadata };
  };

describe("pipeline", () => {
  it("pauses for context when the date is missing", async () => {
    const { graph, cfg, sessionId, llm, interruptValue } = await setup({ llm: [draft()] });
    await graph.invoke({ sessionId }, cfg);
    const st = await graph.getState(cfg);
    expect(st.tasks[0]!.interrupts[0]!.value).toEqual({ type: "context" });
    expect(await interruptValue()).toEqual({ type: "context" });

    const s = (await getSession(db, sessionId))!;
    expect(s).toMatchObject({ stage: "awaiting_context", progress: 55, language: "en", profile: "interview" });
    expect(s.audioKey).toBe(`${sessionId}/audio.mp3`);
    expect(s.proxyKey).toBe(`${sessionId}/proxy.mp4`);
    expect(Math.abs(s.durationMs! - 100_000)).toBeLessThan(500);
    expect(await exists(storage.resolve(s.audioKey!))).toBe(true);
    expect(await exists(storage.resolve(s.proxyKey!))).toBe(true);

    const stored = (await getContextCard(db, sessionId))!;
    expect(stored.round).toBe(1);
    expect(stored.card.sufficient).toBe(false);
    expect(stored.card.openQuestions.map((q) => q.id)).toEqual(["date"]);
    expect(stored.card.language).toMatchObject({ value: "en", source: "video" });
    expect(llm.calls).toHaveLength(1);
  });

  it("skip goes straight to ready after the single context pause", async () => {
    const { graph, cfg, sessionId, llm, resume } = await setup({ llm: [draft()] });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(llm.calls).toHaveLength(1); // no second context round
  });

  it("asks one follow-up round with the new questions, then finishes (never a third round)", async () => {
    const { graph, cfg, sessionId, llm, resume, interruptValue } = await setup({ llm: [draft(), draft(), draft()] });
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
    expect(llm.calls.map((c) => c.name)).toEqual(["context_card", "context_card"]);
    expect(llm.calls[1]!.user).toContain("Q: When was this recorded or first aired?\nA: Maybe last spring");
    expect(llm.calls[1]!.user).not.toContain("ignored answer");

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

    // The second round's answers are folded into the card, then the pipeline finishes even though it is still insufficient.
    await resume({ action: "continue", answers: [{ questionId: "date", answer: "Sometime in 2025" }], cardEdits: {} });
    expect((await graph.getState(cfg)).next).toEqual([]);
    expect(llm.calls.map((c) => c.name)).toEqual(["context_card", "context_card", "context_card"]);
    expect(llm.calls[2]!.user).toContain("A: Maybe last spring");
    expect(llm.calls[2]!.user).toContain("Q: When was this recorded or first aired?\nA: Sometime in 2025");
    expect((await getContextCard(db, sessionId))!.card.sufficient).toBe(false);
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
  });

  it("skipping the follow-up round goes straight to ready", async () => {
    const { graph, cfg, sessionId, llm, resume, interruptValue } = await setup({ llm: [draft(), draft()] });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "continue", answers: [{ questionId: "date", answer: "no idea" }], cardEdits: {} });
    expect(await interruptValue()).toEqual({ type: "context" });
    await resume({ action: "skip" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "ready", progress: 100 });
    expect(llm.calls.map((c) => c.name)).toEqual(["context_card", "context_card"]);
  });

  it("sufficient context never pauses for context", async () => {
    const { graph, cfg, sessionId } = await setup({ llm: [sufficientDraft()] });
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
      llm: [llmDraft],
    });
    await graph.invoke({ sessionId }, cfg);
    expect((await getSession(db, sessionId))!.stage).toBe("ready");

    const s = (await getSession(db, sessionId))!;
    expect(s.title).toBe("Minister interview");
    expect(s.originalKey).toBe(`${sessionId}/original.mp4`);
    expect(s.metadata).toMatchObject({ uploadDate: "2026-03-14", channel: "Canal X", encoder: expect.any(String) });

    const user = llm.calls[0]!.user;
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
        llm: [draft()],
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
      expect(llm.calls.map((c) => c.name)).toEqual(["context_card"]);

      // A duplicate start job for the same session (e.g. redelivered after the pause) changes nothing.
      await handleStart(ctx, { sessionId }, { retryCount: 0, retryLimit: 2 });
      expect(llm.calls).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
});
