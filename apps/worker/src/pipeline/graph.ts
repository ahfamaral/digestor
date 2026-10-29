import path from "node:path";
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  isGraphInterrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import type { ContextCard, Fact, Participant, ResumePayload } from "@digestor/core";
import {
  getContextCard,
  getSession,
  getTranscript,
  listClips,
  replaceAiClips,
  saveContextCard,
  saveTranscript,
  setClipThumb,
  setRenderState,
  setStage,
  updateSession,
  type Db,
  type LocalStorage,
  type Session,
  type Stage,
} from "@digestor/core/server";
import { understandContext } from "../agents/context.js";
import { findClips } from "../agents/clips.js";
import type { StructuredLLM } from "../llm/structured.js";
import type { Transcriber } from "../transcribe/assemblyai.js";
import { YouTubeDownloadError, type downloadYouTube } from "../youtube/ytdlp.js";
import { renderOne } from "./render.js";

export { renderOne };

export type PipelineDeps = {
  db: Db;
  storage: LocalStorage;
  transcriber: Transcriber;
  llm: StructuredLLM;
  media: typeof import("../media/ffmpeg.js");
  youtube: { downloadYouTube: typeof downloadYouTube };
};

const keep = <T>(_old: T, next: T): T => next;

/** Graph state is deliberately small: everything heavy lives in the DB, keyed by sessionId. */
const PipelineState = Annotation.Root({
  sessionId: Annotation<string>,
  round: Annotation<number>({ reducer: keep, default: () => 0 }),
  answers: Annotation<{ question: string; answer: string }[]>({ reducer: keep, default: () => [] }),
  resume: Annotation<ResumePayload | null>({ reducer: keep, default: () => null }),
});
type PipelineStateValue = typeof PipelineState.State;
type PipelineUpdate = typeof PipelineState.Update;
type Node = (state: PipelineStateValue) => Promise<PipelineUpdate>;

const NO_AUDIO = "This video has no audio track.";
const NO_SPEECH = "No speech was detected in this video.";
const DOWNLOAD_FAILED = "Couldn't download this video from YouTube.";
/** Evidence marker for an event type the user picked; such an event type is locked in later rounds. */
const USER_SET_EVIDENCE = "set by user";
const MAX_CONTEXT_ROUNDS = 2;
const NULL_FACT: Fact = { value: null, source: null, evidence: null };

async function requireSession(db: Db, id: string): Promise<Session> {
  const session = await getSession(db, id);
  if (!session) throw new Error(`Session not found: ${id}`);
  return session;
}

/**
 * Pause the graph with `interrupt(payload)`. The stage is only set when actually pausing: on resume the node
 * re-runs from the top and `interrupt` returns the resume value, so the stage set by the API is not overwritten.
 */
async function pause(
  deps: PipelineDeps,
  sessionId: string,
  payload: { type: "context" | "review" },
  stage: Stage,
  progress: number,
): Promise<ResumePayload> {
  try {
    return interrupt<typeof payload, ResumePayload>(payload);
  } catch (err) {
    if (isGraphInterrupt(err)) await setStage(deps.db, sessionId, stage, progress);
    throw err;
  }
}

/** Session metadata (YouTube fields + container tags) as strings for the context prompt. */
function flattenMetadata(metadata: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (k === "durationS") continue; // not context; the prompt only needs title, description, channel, dates, tags
    if (typeof v === "string" && v.trim() !== "") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

const isHuman = (f: Fact): boolean => f.source === "human" && f.value !== null;

/** Facts the human supplied in an earlier round; the context agent must keep them as they are. */
function humanLocked(card: ContextCard): Partial<ContextCard> {
  const locked: Partial<ContextCard> = {};
  if (isHuman(card.title)) locked.title = card.title;
  if (isHuman(card.setting)) locked.setting = card.setting;
  if (isHuman(card.dateOrYear)) locked.dateOrYear = card.dateOrYear;
  if (card.eventType.evidence === USER_SET_EVIDENCE) locked.eventType = card.eventType;
  const pick = (f: Fact): Fact => (isHuman(f) ? f : { ...NULL_FACT });
  const participants = card.participants
    .filter((p) => isHuman(p.name) || isHuman(p.role) || isHuman(p.affiliation))
    .map((p) => ({ speakerId: p.speakerId, name: pick(p.name), role: pick(p.role), affiliation: pick(p.affiliation) }));
  if (participants.length > 0) locked.participants = participants;
  return locked;
}

type CardEdits = Extract<ResumePayload, { action: "continue" }>["cardEdits"];

const filled = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/** Apply the human's edits from the context screen; every typed value becomes a human-sourced fact. */
function applyCardEdits(card: ContextCard, edits: CardEdits): ContextCard {
  const human = (value: string): Fact => ({ value, source: "human", evidence: value });
  const out: ContextCard = { ...card, participants: card.participants.map((p) => ({ ...p })) };
  if (filled(edits.title)) out.title = human(edits.title);
  if (filled(edits.setting)) out.setting = human(edits.setting);
  if (filled(edits.dateOrYear)) out.dateOrYear = human(edits.dateOrYear);
  if (edits.eventType) out.eventType = { value: edits.eventType, confidence: 1, evidence: USER_SET_EVIDENCE };
  for (const e of edits.participants ?? []) {
    const idx = out.participants.findIndex((p) => p.speakerId === e.speakerId);
    const base: Participant =
      idx >= 0
        ? out.participants[idx]!
        : { speakerId: e.speakerId, name: { ...NULL_FACT }, role: { ...NULL_FACT }, affiliation: { ...NULL_FACT } };
    const merged: Participant = {
      ...base,
      ...(filled(e.name) ? { name: human(e.name) } : {}),
      ...(filled(e.role) ? { role: human(e.role) } : {}),
      ...(filled(e.affiliation) ? { affiliation: human(e.affiliation) } : {}),
    };
    if (idx >= 0) out.participants[idx] = merged;
    else out.participants.push(merged);
  }
  return out;
}

export const downloadNode =
  (deps: PipelineDeps): Node =>
  async (s) => {
    const { db, storage } = deps;
    await setStage(db, s.sessionId, "downloading", 2);
    const session = await requireSession(db, s.sessionId);
    let result: Awaited<ReturnType<typeof downloadYouTube>>;
    try {
      if (!session.sourceUrl) throw new Error("YouTube session has no source URL");
      // yt-dlp appends the extension (.mp4).
      result = await deps.youtube.downloadYouTube(session.sourceUrl, storage.resolve(storage.key(s.sessionId, "original")));
    } catch (err) {
      if (err instanceof YouTubeDownloadError) {
        await setStage(db, s.sessionId, "failed", 2, err.message);
      } else {
        console.error(`[pipeline] YouTube download failed for session ${s.sessionId}:`, err);
        await setStage(db, s.sessionId, "failed", 2, DOWNLOAD_FAILED);
      }
      return {};
    }
    await updateSession(db, s.sessionId, {
      originalKey: storage.key(s.sessionId, path.basename(result.videoPath)),
      metadata: { ...session.metadata, ...result.metadata },
      title: result.metadata.title || session.title,
    });
    return {};
  };

export const ingestNode =
  (deps: PipelineDeps): Node =>
  async (s) => {
    const { db, storage, media } = deps;
    await setStage(db, s.sessionId, "preparing", 5);
    const session = await requireSession(db, s.sessionId);
    if (!session.originalKey) throw new Error(`Session ${s.sessionId} has no original video`);
    const original = storage.resolve(session.originalKey);
    const info = await media.probe(original);
    if (!info.hasAudio) {
      await setStage(db, s.sessionId, "failed", 5, NO_AUDIO);
      return {};
    }
    const audioKey = storage.key(s.sessionId, "audio.mp3");
    const proxyKey = storage.key(s.sessionId, "proxy.mp4");
    await media.extractAudio(original, storage.resolve(audioKey));
    await media.makeProxy(original, storage.resolve(proxyKey));
    await updateSession(db, s.sessionId, {
      // Container tags never override metadata we already have (e.g. from YouTube).
      metadata: { ...info.tags, ...session.metadata },
      audioKey,
      proxyKey,
      durationMs: info.durationMs,
    });
    return {};
  };

export const transcribeNode =
  (deps: PipelineDeps): Node =>
  async (s) => {
    const { db, storage } = deps;
    await setStage(db, s.sessionId, "transcribing", 20);
    const session = await requireSession(db, s.sessionId);
    if (!session.audioKey) throw new Error(`Session ${s.sessionId} has no extracted audio`);
    const transcript = await deps.transcriber.transcribe(storage.resolve(session.audioKey));
    if (transcript.words.length === 0) {
      await setStage(db, s.sessionId, "failed", 20, NO_SPEECH);
      return {};
    }
    await saveTranscript(db, s.sessionId, transcript);
    await updateSession(db, s.sessionId, { language: transcript.language });
    return {};
  };

export const understandContextNode =
  (deps: PipelineDeps): Node =>
  async (s) => {
    const { db } = deps;
    await setStage(db, s.sessionId, "understanding", 55);
    const round = s.round + 1;
    const [session, transcript, stored] = await Promise.all([
      requireSession(db, s.sessionId),
      getTranscript(db, s.sessionId),
      getContextCard(db, s.sessionId),
    ]);
    if (!transcript) throw new Error(`Session ${s.sessionId} has no transcript`);
    const card = await understandContext(deps.llm, {
      words: transcript.words,
      language: { code: transcript.language, confidence: transcript.languageConfidence },
      metadata: flattenMetadata(session.metadata),
      hint: session.hint,
      answers: s.answers,
      locked: stored ? humanLocked(stored.card) : {},
    });
    await saveContextCard(db, s.sessionId, card, round);
    await updateSession(db, s.sessionId, { eventType: card.eventType.value });
    return { round };
  };

export const askContextNode =
  (deps: PipelineDeps): Node =>
  async (s) => {
    const { db } = deps;
    const resume = await pause(deps, s.sessionId, { type: "context" }, "awaiting_context", 55);
    if (resume.action !== "continue") return { resume };

    const stored = await getContextCard(db, s.sessionId);
    if (!stored) throw new Error(`Session ${s.sessionId} has no context card`);
    await saveContextCard(db, s.sessionId, applyCardEdits(stored.card, resume.cardEdits), stored.round);

    const questions = new Map(stored.card.openQuestions.map((q) => [q.id, q.question]));
    const answers = resume.answers.flatMap((a) => {
      const question = questions.get(a.questionId);
      return question === undefined || a.answer.trim() === "" ? [] : [{ question, answer: a.answer }];
    });
    return { resume, answers: [...s.answers, ...answers] };
  };

export const findClipsNode =
  (deps: PipelineDeps): Node =>
  async (s) => {
    const { db, storage, media } = deps;
    await setStage(db, s.sessionId, "finding_clips", 70);
    const [session, transcript, stored] = await Promise.all([
      requireSession(db, s.sessionId),
      getTranscript(db, s.sessionId),
      getContextCard(db, s.sessionId),
    ]);
    if (!transcript) throw new Error(`Session ${s.sessionId} has no transcript`);
    if (!stored) throw new Error(`Session ${s.sessionId} has no context card`);

    const tree = await findClips(deps.llm, { card: stored.card, transcript });
    // Replaces earlier AI proposals, so a re-run (retry after a crash) never duplicates clips.
    const created = await replaceAiClips(db, s.sessionId, tree);

    const videoKey = session.proxyKey ?? session.originalKey;
    if (!videoKey) throw new Error(`Session ${s.sessionId} has no video`);
    const video = storage.resolve(videoKey);
    for (const clip of created) {
      const key = storage.key(s.sessionId, `thumbs/${clip.id}.jpg`);
      try {
        await media.thumbnail(video, Math.round((clip.startMs + clip.endMs) / 2), storage.resolve(key));
      } catch (err) {
        console.error(`[pipeline] thumbnail failed for clip ${clip.id}:`, err);
        continue;
      }
      await setClipThumb(db, clip.id, key);
    }
    return {};
  };

export const reviewNode =
  (deps: PipelineDeps): Node =>
  async (s) => ({ resume: await pause(deps, s.sessionId, { type: "review" }, "awaiting_review", 70) });

export const renderNode =
  (deps: PipelineDeps): Node =>
  async (s) => {
    const { db } = deps;
    await setStage(db, s.sessionId, "rendering", 90);
    const approved = (await listClips(db, s.sessionId)).filter((c) => c.status === "approved");
    for (const clip of approved) await setRenderState(db, clip.id, { renderStatus: "queued" });
    for (const clip of approved) await renderOne(deps, clip.id);
    await setStage(db, s.sessionId, "done", 100);
    return {};
  };

export function buildPipeline(deps: PipelineDeps, checkpointer: BaseCheckpointSaver) {
  const { db } = deps;
  const unlessFailed =
    <T extends string>(next: T) =>
    async (s: PipelineStateValue): Promise<T | typeof END> =>
      (await getSession(db, s.sessionId))?.stage === "failed" ? END : next;

  return new StateGraph(PipelineState)
    .addNode("download", downloadNode(deps))
    .addNode("ingest", ingestNode(deps))
    .addNode("transcribe", transcribeNode(deps))
    .addNode("understand_context", understandContextNode(deps))
    .addNode("ask_context", askContextNode(deps))
    .addNode("find_clips", findClipsNode(deps))
    .addNode("review", reviewNode(deps))
    .addNode("render", renderNode(deps))
    .addConditionalEdges(
      START,
      async (s) => {
        const session = await requireSession(db, s.sessionId);
        return session.source === "youtube" && session.originalKey === null ? "download" : "ingest";
      },
      ["download", "ingest"],
    )
    .addConditionalEdges("download", unlessFailed("ingest"), ["ingest", END])
    .addConditionalEdges("ingest", unlessFailed("transcribe"), ["transcribe", END])
    .addConditionalEdges("transcribe", unlessFailed("understand_context"), ["understand_context", END])
    .addConditionalEdges(
      "understand_context",
      async (s) => {
        const stored = await getContextCard(db, s.sessionId);
        return stored?.card.sufficient || s.round >= MAX_CONTEXT_ROUNDS ? "find_clips" : "ask_context";
      },
      ["find_clips", "ask_context"],
    )
    .addConditionalEdges(
      "ask_context",
      // Any other action is not valid at this pause: ask again.
      (s) => (s.resume?.action === "skip" ? "find_clips" : s.resume?.action === "continue" ? "understand_context" : "ask_context"),
      ["find_clips", "understand_context", "ask_context"],
    )
    .addEdge("find_clips", "review")
    .addConditionalEdges("review", (s) => (s.resume?.action === "render" ? "render" : "review"), ["render", "review"])
    .addEdge("render", END)
    .compile({ checkpointer });
}
