import { access, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  getClip,
  getContextCard,
  getSession,
  listClips,
  saveContextCard,
  saveTranscript,
  setClipBounds,
  setClipStatus,
  setRenderState,
  setStage,
  updateSession,
  type Db,
} from "@digestor/core/server";
import * as media from "../media/ffmpeg.js";
import { FakeTranscriber } from "../transcribe/assemblyai.js";
import { FakeLLM } from "../llm/structured.js";
import { YouTubeDownloadError, mapYtDlpError, type YouTubeMetadata, type downloadYouTube } from "../youtube/ytdlp.js";
import { buildPipeline, findClipsNode, renderNode, type PipelineDeps } from "./graph.js";
import { renderOne } from "./render.js";

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

/** LLM draft card: event type and speaker A are grounded in the transcript; the date is whatever is passed. */
function draft(date: Fact = none): ContextCard {
  return {
    language: none,
    eventType: { value: "interview", confidence: 0.9, evidence: "Sentence number 2." },
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

const cand = (title: string, score: number, start: string, end: string) => ({
  title, reason: "r", label: "key_point", score, start, end, evidence: [],
});
// Snaps to 0–31.85 s, 32.85–64.85 s and 65.85–97.85 s; no hot takes.
const clipPass = [
  {
    clips: [
      cand("One", 90, "00:00:00", "00:00:33"),
      cand("Two", 80, "00:00:33", "00:01:06"),
      cand("Three", 70, "00:01:06", "00:01:39"),
    ],
  },
  { hotTakes: [] },
  { hotTakes: [] },
  { hotTakes: [] },
];

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
    transcriber: new FakeTranscriber(o.transcript ?? transcript),
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
    expect(s).toMatchObject({ stage: "awaiting_context", progress: 55, language: "en", eventType: "interview" });
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

  it("an invalid action at the context pause pauses again without a resumed node re-setting the stage", async () => {
    // The resumed ask_context gets {action:"render"} back from interrupt() (no stage write), routes back to
    // ask_context, and that fresh run pauses again: only the real pause sets awaiting_context.
    const { graph, cfg, sessionId, llm, resume, interruptValue } = await setup({ llm: [draft()] });
    await graph.invoke({ sessionId }, cfg);
    await setStage(db, sessionId, "understanding", 55);
    await resume({ action: "render" });
    expect(await interruptValue()).toEqual({ type: "context" });
    expect((await graph.getState(cfg)).next).toEqual(["ask_context"]);
    expect((await getSession(db, sessionId))!.stage).toBe("awaiting_context");
    expect(llm.calls).toHaveLength(1);
  });

  it("skip goes straight to review with clips stored", async () => {
    const { graph, cfg, sessionId, llm, resume, interruptValue } = await setup({ llm: [draft(), ...clipPass] });
    await graph.invoke({ sessionId }, cfg);
    await resume({ action: "skip" });
    expect(await interruptValue()).toEqual({ type: "review" });
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "awaiting_review", progress: 70 });
    expect(llm.calls).toHaveLength(1 + 1 + 3); // no second context round

    const clips = await listClips(db, sessionId);
    expect(clips.map((c) => c.title)).toEqual(["One", "Two", "Three"]);
    for (const c of clips) {
      expect(c.thumbKey).toBe(`${sessionId}/thumbs/${c.id}.jpg`);
      expect(await exists(storage.resolve(c.thumbKey!))).toBe(true);
    }
  });

  it("asks at most one follow-up round", async () => {
    const { graph, cfg, sessionId, llm, resume, interruptValue } = await setup({ llm: [draft(), draft(), ...clipPass] });
    await graph.invoke({ sessionId }, cfg);
    await resume({
      action: "continue",
      answers: [
        { questionId: "date", answer: "Maybe last spring" },
        { questionId: "unknown", answer: "ignored answer" },
      ],
      cardEdits: { title: "Budget hearing", eventType: "court", participants: [{ speakerId: "A", name: "Maria Silva" }] },
    });
    expect(await interruptValue()).toEqual({ type: "review" });
    expect(llm.calls.map((c) => c.name)).toEqual(["context_card", "context_card", "long_clips", "hot_takes", "hot_takes", "hot_takes"]);
    expect(llm.calls[1]!.user).toContain("Q: When was this recorded or first aired?\nA: Maybe last spring");
    expect(llm.calls[1]!.user).not.toContain("ignored answer");

    const stored = (await getContextCard(db, sessionId))!;
    expect(stored.round).toBe(2);
    expect(stored.card.sufficient).toBe(false);
    expect(stored.card.title).toEqual({ value: "Budget hearing", source: "human", evidence: "Budget hearing" });
    expect(stored.card.eventType).toEqual({ value: "court", confidence: 1, evidence: "set by user" });
    expect(stored.card.participants).toEqual([
      {
        speakerId: "A",
        name: { value: "Maria Silva", source: "human", evidence: "Maria Silva" },
        role: fact("host", "video", "Sentence number 1."),
        affiliation: none,
      },
    ]);
    expect((await getSession(db, sessionId))!.eventType).toBe("court");
  });

  it("sufficient context never pauses for context", async () => {
    const { graph, cfg, sessionId, interruptValue } = await setup({ llm: [sufficientDraft(), ...clipPass] });
    await graph.invoke({ sessionId }, cfg);
    expect(await interruptValue()).toEqual({ type: "review" });
    expect((await getContextCard(db, sessionId))!).toMatchObject({ round: 1, card: { sufficient: true } });
  });

  it("render only renders approved clips", async () => {
    const { graph, cfg, sessionId, resume } = await setup({ llm: [sufficientDraft(), ...clipPass] });
    await graph.invoke({ sessionId }, cfg);
    const [first, ...others] = await listClips(db, sessionId);
    await setClipStatus(db, first!.id, "approved", "user");
    await setClipStatus(db, others[0]!.id, "rejected", "user");
    await resume({ action: "render" });

    expect(await getSession(db, sessionId)).toMatchObject({ stage: "done", progress: 100 });
    expect((await graph.getState(cfg)).next).toEqual([]);

    const done = (await getClip(db, first!.id))!;
    expect(done).toMatchObject({
      renderStatus: "done",
      renderKey: `${sessionId}/clips/${first!.id}.mp4`,
      srtKey: `${sessionId}/clips/${first!.id}.srt`,
    });
    const rendered = await media.probe(storage.resolve(done.renderKey!));
    expect(Math.abs(rendered.durationMs - (first!.endMs - first!.startMs))).toBeLessThan(500);
    expect(rendered.width).toBe(320);
    const srt = await readFile(storage.resolve(done.srtKey!), "utf8");
    expect(srt).toContain("1\n00:00:00,000 --> ");
    expect(srt).toContain("Sentence number 0.");
    expect(await exists(storage.resolve(`${sessionId}/clips/${first!.id}.ass`))).toBe(false);

    for (const c of others) {
      expect(await getClip(db, c.id)).toMatchObject({ renderStatus: "none", renderKey: null, srtKey: null });
    }
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
    const { graph, cfg, sessionId, llm, interruptValue } = await setup({
      youtube: youtubeStub(metadata),
      llm: [llmDraft, ...clipPass],
    });
    await graph.invoke({ sessionId }, cfg);
    expect(await interruptValue()).toEqual({ type: "review" });

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
});

describe("nodes", () => {
  async function readyForClips(o: Setup) {
    const ctx = await setup(o);
    await saveTranscript(db, ctx.sessionId, transcript);
    await saveContextCard(db, ctx.sessionId, { ...sufficientDraft(), sufficient: true }, 1);
    return ctx;
  }
  const state = (sessionId: string) => ({ sessionId, round: 1, answers: [], resume: null });

  it("re-running find_clips does not duplicate clips", async () => {
    const { deps, sessionId } = await readyForClips({ llm: [...clipPass, ...clipPass] });
    await findClipsNode(deps)(state(sessionId));
    expect(await listClips(db, sessionId)).toHaveLength(3);
    await findClipsNode(deps)(state(sessionId));
    expect(await listClips(db, sessionId)).toHaveLength(3);
  });

  it("a failing thumbnail does not fail find_clips", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingThumb = { ...media, thumbnail: async () => Promise.reject(new Error("boom")) };
      const { deps, sessionId } = await readyForClips({ llm: clipPass, media: failingThumb });
      await findClipsNode(deps)(state(sessionId));
      const clips = await listClips(db, sessionId);
      expect(clips).toHaveLength(3);
      expect(clips.every((c) => c.thumbKey === null)).toBe(true);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("render skips clips that are already rendered (retry-safe)", async () => {
    const rendered: string[] = [];
    const counting = {
      ...media,
      renderClip: async (o: Parameters<typeof media.renderClip>[0]) => {
        rendered.push(o.output);
        return media.renderClip(o);
      },
    };
    const { deps, sessionId } = await readyForClips({ llm: clipPass, media: counting });
    await findClipsNode(deps)(state(sessionId));
    const [doneClip, todo] = await listClips(db, sessionId);
    for (const c of [doneClip!, todo!]) await setClipStatus(db, c.id, "approved", "user");
    const doneKey = storage.key(sessionId, `clips/${doneClip!.id}.mp4`);
    await writeFile(storage.resolve(doneKey), "already rendered");
    const before = (await stat(storage.resolve(doneKey))).mtimeMs;
    await setRenderState(db, doneClip!.id, { renderStatus: "done", renderKey: doneKey });

    await renderNode(deps)(state(sessionId));

    expect(rendered).toEqual([storage.resolve(storage.key(sessionId, `clips/${todo!.id}.mp4`))]);
    expect(await getClip(db, doneClip!.id)).toMatchObject({ renderStatus: "done", renderKey: doneKey });
    expect((await stat(storage.resolve(doneKey))).mtimeMs).toBe(before);
    expect((await getClip(db, todo!.id))!.renderStatus).toBe("done");
    expect(await getSession(db, sessionId)).toMatchObject({ stage: "done", progress: 100 });
  });

  it("one failing render does not stop the others or fail the session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let badId = "";
      const flaky = {
        ...media,
        renderClip: async (o: Parameters<typeof media.renderClip>[0]) =>
          o.output.includes(badId) ? Promise.reject(new Error("render boom")) : media.renderClip(o),
      };
      const { deps, sessionId } = await readyForClips({ llm: clipPass, media: flaky });
      await findClipsNode(deps)(state(sessionId));
      const [bad, good] = await listClips(db, sessionId);
      badId = bad!.id;
      for (const c of [bad!, good!]) await setClipStatus(db, c.id, "approved", "user");

      await renderNode(deps)(state(sessionId));

      expect((await getClip(db, bad!.id))!.renderStatus).toBe("failed");
      expect(await getClip(db, good!.id)).toMatchObject({ renderStatus: "done", renderKey: `${sessionId}/clips/${good!.id}.mp4` });
      expect(await getSession(db, sessionId)).toMatchObject({ stage: "done", progress: 100 });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["its times were edited", (id: string) => setClipBounds(db, id, { startMs: 3000, endMs: 9850 }, "user")],
    ["it was un-approved", (id: string) => setClipStatus(db, id, "neutral", "user")],
  ])("renderOne marks the render stale when, mid-render, %s", async (_case, change) => {
    let clipId = "";
    const racing = {
      ...media,
      renderClip: async (o: Parameters<typeof media.renderClip>[0]) => {
        const out = await media.renderClip(o);
        await change(clipId); // the user acts while ffmpeg runs
        return out;
      },
    };
    const { deps, sessionId } = await readyForClips({ llm: clipPass, media: racing });
    await findClipsNode(deps)(state(sessionId));
    const [clip] = await listClips(db, sessionId);
    clipId = clip!.id;
    await setClipStatus(db, clipId, "approved", "user");

    await renderOne(deps, clipId);

    const renderKey = `${sessionId}/clips/${clipId}.mp4`;
    expect(await getClip(db, clipId)).toMatchObject({ renderStatus: "stale", renderKey, srtKey: `${sessionId}/clips/${clipId}.srt` });
    expect(await exists(storage.resolve(renderKey))).toBe(true);
  });

  it("renderOne marks an unchanged approved clip done", async () => {
    const { deps, sessionId } = await readyForClips({ llm: clipPass });
    await findClipsNode(deps)(state(sessionId));
    const [clip] = await listClips(db, sessionId);
    await setClipStatus(db, clip!.id, "approved", "user");
    await renderOne(deps, clip!.id);
    expect(await getClip(db, clip!.id)).toMatchObject({
      renderStatus: "done",
      renderKey: `${sessionId}/clips/${clip!.id}.mp4`,
      srtKey: `${sessionId}/clips/${clip!.id}.srt`,
    });
  });

  it("renderOne marks the clip failed, removes the temp .ass and rethrows", async () => {
    const failingRender = { ...media, renderClip: async () => Promise.reject(new Error("render boom")) };
    const { deps, sessionId } = await readyForClips({ llm: clipPass, media: failingRender });
    await findClipsNode(deps)(state(sessionId));
    const [clip] = await listClips(db, sessionId);
    await expect(renderOne(deps, clip!.id)).rejects.toThrow("render boom");
    expect((await getClip(db, clip!.id))!.renderStatus).toBe("failed");
    expect(await exists(storage.resolve(`${sessionId}/clips/${clip!.id}.ass`))).toBe(false);
  });
});
