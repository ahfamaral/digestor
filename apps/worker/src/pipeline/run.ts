import path from "node:path";
import { OWNER_ID, suggestRecord, type ContextCard, type Fact, type Participant, type PipelineStep, type ResumePayload, type Transcript } from "@digestor/core";
import {
  advancePipelineRun,
  createCustomPerson,
  ensurePipelineRun,
  findPersonByName,
  getContextCard,
  getCurrentAnalysis,
  getPersons,
  getPipelineRun,
  getSession,
  getTranscript,
  listAttributions,
  requestProxy,
  settlePreview,
  PREVIEW_FAILED,
  saveContextCard,
  setHumanAttribution,
  saveTranscript,
  setStage,
  suggestRecordRow,
  updateSession,
  type Db,
  type LocalStorage,
  type PipelineRun,
  type Session,
  type Stage,
} from "@digestor/core/server";
import type { ChromaClient } from "chromadb";
import { understandContext } from "../agents/context.js";
import type { Embedder } from "../search/embed.js";
import { indexSession } from "../search/index.js";
import { runAnalysis } from "./analysis.js";
import { releaseAudio } from "./audio.js";
import { importContextNames, lockedParticipants, matchRecordNode, nameSpeakersNode, namedVoices } from "./naming.js";
import type { StructuredLLM } from "../llm/structured.js";
import { TranscriptionError, type Transcriber } from "../transcribe/assemblyai.js";
import { YouTubeDownloadError, type downloadYouTube } from "../youtube/ytdlp.js";

export type PipelineDeps = {
  db: Db;
  storage: LocalStorage;
  transcriber: Transcriber;
  llm: StructuredLLM;
  media: typeof import("../media/ffmpeg.js");
  youtube: { downloadYouTube: typeof downloadYouTube };
  search: { chroma: ChromaClient; embedder: Embedder };
  /** Injected in tests (record fetches); the real `fetch` otherwise. */
  fetch?: typeof fetch;
  /** Sends `session.names` for a session (set by the worker's main; the job claims the row first, so a double send is harmless). */
  enqueueNames?: (sessionId: string) => Promise<void>;
  /** Sends `session.proxy` (set by the worker's main; the job claims the row first, so a double send is harmless). */
  enqueueProxy?: (sessionId: string) => Promise<void>;
};

/**
 * What a step tells the runner: the step to run next (with the context round and answers to store), `pause` (waiting
 * for the journalist's answer), or `stop` (the step set the session `failed`).
 */
export type StepResult = { next: PipelineStep; round?: number; answers?: PipelineRun["answers"] } | { pause: true } | { stop: true };
/** A pipeline step. Every step is safe to run twice: a crash before the run advances re-runs it. */
export type Step = (deps: PipelineDeps, run: PipelineRun, resume?: ResumePayload) => Promise<StepResult>;

const STOP = { stop: true } as const;

const NO_AUDIO = "This video has no audio track.";
const NO_SPEECH = "No speech was detected in this video.";
const UNREADABLE_VIDEO = "We couldn't read this video file.";
/** AssemblyAI's error (with language_detection on) for audio without speech: "…cannot be performed on files with no spoken audio". */
const NO_SPOKEN_AUDIO = /no spoken audio/i;
const DOWNLOAD_FAILED = "Couldn't download this video from YouTube.";
/** Evidence marker for an event type the user picked; such an event type is locked in later rounds. */
const USER_SET_EVIDENCE = "set by user";
/** Question rounds: the first round plus at most one follow-up. */
const MAX_CONTEXT_ROUNDS = 2;
const NULL_FACT: Fact = { value: null, source: null, evidence: null };

async function requireSession(db: Db, id: string): Promise<Session> {
  const session = await getSession(db, id);
  if (!session) throw new Error(`Session not found: ${id}`);
  return session;
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
  if (card.profile.evidence === USER_SET_EVIDENCE) locked.profile = card.profile;
  if (isHuman(card.language)) locked.language = card.language;
  const pick = (f: Fact): Fact => (isHuman(f) ? f : { ...NULL_FACT });
  // Names are never locked from the card: they come from the attributions (`lockedParticipants`).
  const participants = card.participants
    .filter((p) => isHuman(p.role) || isHuman(p.affiliation))
    .map((p) => ({ speakerId: p.speakerId, name: { ...NULL_FACT }, role: pick(p.role), affiliation: pick(p.affiliation) }));
  if (participants.length > 0) locked.participants = participants;
  return locked;
}

type CardEdits = Extract<ResumePayload, { action: "continue" }>["cardEdits"];

const filled = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/** Apply the human's edits from the context screen; every typed value becomes a human-sourced fact (names are attributions, see `applyNameEdits`). */
function applyCardEdits(card: ContextCard, edits: CardEdits): ContextCard {
  const human = (value: string): Fact => ({ value, source: "human", evidence: value });
  const out: ContextCard = { ...card, participants: card.participants.map((p) => ({ ...p })) };
  if (filled(edits.title)) out.title = human(edits.title);
  if (filled(edits.setting)) out.setting = human(edits.setting);
  if (filled(edits.dateOrYear)) out.dateOrYear = human(edits.dateOrYear);
  if (edits.profile) out.profile = { value: edits.profile, confidence: 1, evidence: USER_SET_EVIDENCE };
  if (filled(edits.language)) out.language = human(edits.language);
  for (const e of edits.participants ?? []) {
    const idx = out.participants.findIndex((p) => p.speakerId === e.speakerId);
    const base: Participant =
      idx >= 0
        ? out.participants[idx]!
        : { speakerId: e.speakerId, name: { ...NULL_FACT }, role: { ...NULL_FACT }, affiliation: { ...NULL_FACT } };
    const merged: Participant = {
      ...base,
      ...(filled(e.role) ? { role: human(e.role) } : {}),
      ...(filled(e.affiliation) ? { affiliation: human(e.affiliation) } : {}),
    };
    if (idx >= 0) out.participants[idx] = merged;
    else out.participants.push(merged);
  }
  return out;
}

/** A typed participant name is a human attribution for the whole voice. Idempotent: persons are found by name first. */
async function applyNameEdits(db: Db, sessionId: string, edits: CardEdits): Promise<void> {
  for (const e of edits.participants ?? []) {
    if (!filled(e.name)) continue;
    const name = e.name.trim();
    const person = (await findPersonByName(db, name)) ?? (await createCustomPerson(db, { displayName: name, createdBy: OWNER_ID }));
    await setHumanAttribution(db, { sessionId, speakerId: e.speakerId, startMs: null, endMs: null, personId: person.id, ownerId: OWNER_ID });
  }
}

const download: Step = async (deps, s) => {
  const { db, storage } = deps;
  await setStage(db, s.sessionId, "downloading", 2);
  const session = await requireSession(db, s.sessionId);
  let result: Awaited<ReturnType<typeof downloadYouTube>>;
  try {
    if (!session.sourceUrl) throw new Error("YouTube session has no source URL");
    // A speech clipped from the monitor: only its part of the video (times in the session are relative to it).
    const section = session.sourceStartMs !== null && session.sourceEndMs !== null
      ? { startS: Math.floor(session.sourceStartMs / 1000), endS: Math.ceil(session.sourceEndMs / 1000) }
      : undefined;
    // yt-dlp appends the extension (.mp4).
    result = await deps.youtube.downloadYouTube(session.sourceUrl, storage.resolve(storage.key(s.sessionId, "original")), undefined, section);
  } catch (err) {
    if (err instanceof YouTubeDownloadError) {
      await setStage(db, s.sessionId, "failed", 2, err.message);
    } else {
      console.error(`[pipeline] YouTube download failed for session ${s.sessionId}:`, err);
      await setStage(db, s.sessionId, "failed", 2, DOWNLOAD_FAILED);
    }
    return STOP;
  }
  await updateSession(db, s.sessionId, {
    originalKey: storage.key(s.sessionId, path.basename(result.videoPath)),
    metadata: { ...session.metadata, ...result.metadata },
    // A part of a video keeps the title it was given (the whole plenary's title would name every speech alike).
    title: session.sourceStartMs !== null ? session.title : result.metadata.title || session.title,
  });
  // A suggestion only: the journalist confirms it at the context check. Idempotent (no row yet), never fatal.
  try {
    const ref = suggestRecord(result.metadata);
    if (ref) await suggestRecordRow(db, s.sessionId, ref);
  } catch (err) {
    console.error(`[pipeline] record suggestion failed for session ${s.sessionId}:`, err);
  }
  return { next: "ingest" };
};

const ingest: Step = async (deps, s) => {
  const { db, storage, media } = deps;
  await setStage(db, s.sessionId, "preparing", 5);
  const session = await requireSession(db, s.sessionId);
  if (!session.originalKey) throw new Error(`Session ${s.sessionId} has no original video`);
  const original = storage.resolve(session.originalKey);
  let info: Awaited<ReturnType<typeof media.probe>>;
  try {
    info = await media.probe(original);
  } catch (err) {
    // Zero-byte, truncated or not a video at all: retrying can't help.
    console.error(`[pipeline] probe failed for session ${s.sessionId}:`, err);
    await setStage(db, s.sessionId, "failed", 5, UNREADABLE_VIDEO);
    return STOP;
  }
  if (!info.hasAudio) {
    await setStage(db, s.sessionId, "failed", 5, NO_AUDIO);
    return STOP;
  }
  // No picture: go on as audio-only (clips show a waveform). An audio extension was acknowledged at upload; a video
  // container without a picture wasn't, so the web shows the same notice from `hasVideo` false + `audioOnlyAck` false.
  const audioKey = storage.key(s.sessionId, "audio.mp3");
  await media.extractAudio(original, storage.resolve(audioKey));
  await updateSession(db, s.sessionId, {
    // Container tags never override metadata we already have (e.g. from YouTube).
    metadata: { ...info.tags, ...session.metadata },
    audioKey,
    durationMs: info.durationMs,
    hasVideo: info.hasVideo,
  });
  // The 360p preview copy is its own job: transcription starts now, and the session is `ready` once both are done.
  if (!deps.enqueueProxy) throw new Error("enqueueProxy is not wired: the preview copy would never be made");
  await requestProxy(db, s.sessionId);
  await deps.enqueueProxy(s.sessionId); // a failed send throws: the step is retried
  return { next: "transcribe" };
};

const transcribe: Step = async (deps, s) => {
  const { db, storage } = deps;
  await setStage(db, s.sessionId, "transcribing", 20);
  const session = await requireSession(db, s.sessionId);
  if (!session.audioKey) throw new Error(`Session ${s.sessionId} has no extracted audio`);
  let transcript: Transcript;
  try {
    transcript = await deps.transcriber.transcribe(storage.resolve(session.audioKey), session.durationMs ?? undefined, {
      ...(session.languageOverride ? { languageCode: session.languageOverride } : {}),
    });
  } catch (err) {
    if (!(err instanceof TranscriptionError && NO_SPOKEN_AUDIO.test(err.message))) throw err;
    await setStage(db, s.sessionId, "failed", 20, NO_SPEECH);
    return STOP;
  }
  if (transcript.words.length === 0) {
    await setStage(db, s.sessionId, "failed", 20, NO_SPEECH);
    return STOP;
  }
  await saveTranscript(db, s.sessionId, transcript);
  await updateSession(db, s.sessionId, { language: transcript.language });
  return { next: "match_record" };
};

const understandContextStep: Step = async (deps, s) => {
  const { db } = deps;
  await setStage(db, s.sessionId, "understanding", 55);
  const round = s.round + 1;
  const [session, transcript, stored] = await Promise.all([
    requireSession(db, s.sessionId),
    getTranscript(db, s.sessionId),
    getContextCard(db, s.sessionId),
  ]);
  if (!transcript) throw new Error(`Session ${s.sessionId} has no transcript`);
  const atts = await listAttributions(db, s.sessionId);
  const persons = await getPersons(db, [...new Set(atts.flatMap((a) => (a.personId ? [a.personId] : [])))]);
  const fromCard = stored ? humanLocked(stored.card) : {};
  const fromAtts = lockedParticipants(atts, persons, transcript.words);
  // Locked names are the confirmed attributions only; human role and affiliation come from the card.
  const participants = [
    ...(fromCard.participants ?? []).map((p) => {
      const a = fromAtts.find((x) => x.speakerId === p.speakerId);
      return a ? { ...p, name: a.name } : p;
    }),
    ...fromAtts.filter((a) => !(fromCard.participants ?? []).some((p) => p.speakerId === a.speakerId)),
  ];
  const card = await understandContext(deps.llm, {
    words: transcript.words,
    language: { code: transcript.language, confidence: transcript.languageConfidence },
    metadata: flattenMetadata(session.metadata),
    hint: session.hint,
    answers: s.answers,
    locked: { ...fromCard, ...(participants.length > 0 ? { participants } : {}) },
    named: namedVoices(atts, [...new Set(transcript.words.map((w) => w.speaker))], transcript.words),
  });
  await saveContextCard(db, s.sessionId, card, round);
  await importContextNames(db, s.sessionId, card);
  await updateSession(db, s.sessionId, {
    profile: card.profile.value,
    ...(card.language.value !== null ? { language: card.language.value } : {}),
  });
  // After the follow-up round's answers this pass only folds them into the card: no third question round.
  return { next: card.sufficient || round > MAX_CONTEXT_ROUNDS ? "match_record_late" : "ask_context", round };
};

/** The context check. Without an answer it pauses (the runner writes the pause stage when it advances into this step). */
const askContext: Step = async (deps, s, resume) => {
  const { db } = deps;
  if (!resume) return { pause: true };

  const stored = await getContextCard(db, s.sessionId);
  if (!stored) throw new Error(`Session ${s.sessionId} has no context card`);
  if (resume.action === "skip") {
    // Skip asks nothing more, but keeps what the journalist changed (a profile set to trial stops caption reading).
    if (resume.cardEdits) {
      await applyNameEdits(db, s.sessionId, resume.cardEdits);
      const card = applyCardEdits(stored.card, resume.cardEdits);
      await saveContextCard(db, s.sessionId, card, stored.round);
      await updateSession(db, s.sessionId, { profile: card.profile.value, ...(card.language.value !== null ? { language: card.language.value } : {}) });
    }
    return { next: "match_record_late" };
  }
  await applyNameEdits(db, s.sessionId, resume.cardEdits);
  await saveContextCard(db, s.sessionId, applyCardEdits(stored.card, resume.cardEdits), stored.round);

  const questions = new Map(stored.card.openQuestions.map((q) => [q.id, q.question]));
  const answers = resume.answers.flatMap((a) => {
    const question = questions.get(a.questionId);
    return question === undefined || a.answer.trim() === "" ? [] : [{ question, answer: a.answer }];
  });
  return { next: "understand_context", answers: [...s.answers, ...answers] };
};

/**
 * Indexes the transcript into the session's Chroma collection (idempotent). Search is optional: on any failure it logs
 * and carries on, so the session is still analysed (Ask then answers "Search isn't available for this video.").
 */
const index: Step = async (deps, s) => {
  await setStage(deps.db, s.sessionId, "indexing", 70);
  try {
    const transcript = await getTranscript(deps.db, s.sessionId);
    if (!transcript) throw new Error(`Session ${s.sessionId} has no transcript`);
    await indexSession(deps.search, s.sessionId, transcript.words);
  } catch (err) {
    console.error(`index: could not index the transcript of session ${s.sessionId}; continuing without search`, err);
  }
  return { next: "analyze" };
};

/** The first analysis version, with the profile from the context card. Safe to re-run (see `runAnalysis`). */
const analyze: Step = async (deps, s) => {
  const { db } = deps;
  // Completed before a crash that kept the run from advancing: don't analyse (and pay) again.
  if (await getCurrentAnalysis(db, s.sessionId)) {
    if ((await requireSession(db, s.sessionId)).stage === "ready") {
      // The join already closed it; a crash between the join and the release may have left audio.mp3 behind.
      await releaseAudio({ db, storage: deps.storage }, s.sessionId);
      return { next: "done" };
    }
    await setStage(db, s.sessionId, "preparing_preview", 96);
    await settlePreview(db, s.sessionId);
    await releaseAudio({ db, storage: deps.storage }, s.sessionId);
    return { next: "done" };
  }
  // The preview copy already gave up (during the context pause): fail now rather than after a paid analysis.
  const session = await requireSession(db, s.sessionId);
  if (session.proxyStatus === "failed") {
    await setStage(db, s.sessionId, "failed", session.progress, PREVIEW_FAILED);
    return STOP;
  }
  const stored = await getContextCard(db, s.sessionId);
  if (!stored) throw new Error(`Session ${s.sessionId} has no context card`);
  await runAnalysis(deps, s.sessionId, { profile: stored.card.profile.value, reason: "initial" });
  return { next: "done" };
};

/** A step from `naming.ts` (it never fails the session itself), followed by `next`. */
const andThen =
  (node: (deps: PipelineDeps) => (s: { sessionId: string }) => Promise<unknown>, next: PipelineStep): Step =>
  async (deps, s) => {
    await node(deps)(s);
    return { next };
  };

/** The steps in order; each returns the one after it (the order and branches of the old LangGraph graph). */
export const STEPS: Record<Exclude<PipelineStep, "done">, Step> = {
  download,
  ingest,
  transcribe,
  match_record: andThen(matchRecordNode, "understand_context"),
  understand_context: understandContextStep,
  ask_context: askContext,
  // The record step again, after the context check: a suggestion accepted at the pause (pending) is matched here; with no pending record it does nothing.
  match_record_late: andThen(matchRecordNode, "name_speakers"),
  name_speakers: andThen(nameSpeakersNode, "index"),
  index,
  analyze,
};

/** Steps after which a session some other path marked `failed` (e.g. the sweep) does not go on. */
const STOPS_IF_FAILED: ReadonlySet<PipelineStep> = new Set(["download", "ingest", "transcribe", "match_record", "understand_context", "ask_context", "match_record_late", "name_speakers"]);

/** Where a YouTube session without a file, or an upload, starts. */
export function firstStepFor(session: Pick<Session, "source" | "originalKey">): PipelineStep {
  return session.source === "youtube" && session.originalKey === null ? "download" : "ingest";
}

/**
 * The step a session without a run row is at, from its stage: sessions the old LangGraph pipeline left mid-run when
 * this runner was deployed (their checkpoints are gone). `uploaded` is the session's first step; `failed` has none.
 */
export function stepForStage(stage: Stage, firstStep: PipelineStep): PipelineStep | null {
  switch (stage) {
    case "uploaded":
      return firstStep;
    case "downloading":
      return "download";
    case "preparing":
      return "ingest";
    case "transcribing":
      return "transcribe";
    case "understanding":
      return "understand_context";
    case "awaiting_context":
      return "ask_context";
    case "naming_speakers":
      return "name_speakers";
    case "indexing":
      return "index";
    case "finding_topics":
    case "finding_moments":
    case "writing_briefing":
    case "preparing_preview":
      return "analyze";
    case "ready":
      return "done";
    case "failed":
      return null;
  }
}

/** The stages the web's context route leaves a session in when it sends `session.resume` (or the pause itself). */
const ANSWERED_STAGES: ReadonlySet<Stage> = new Set<Stage>(["awaiting_context", "understanding", "naming_speakers"]);

/** The run's row, created for a session that has none (a new session, or one left by the old pipeline); null = nothing to run. */
async function loadRun(deps: PipelineDeps, session: Session, resume: ResumePayload | undefined): Promise<PipelineRun | null> {
  const found = await getPipelineRun(deps.db, session.id);
  if (found) return found;
  // A session paused under LangGraph and answered after the deploy: the web has already moved its stage on, and the answer
  // belongs to the context check, so the run starts there instead of at the stage's step.
  const first = resume && ANSWERED_STAGES.has(session.stage) ? "ask_context" : stepForStage(session.stage, firstStepFor(session));
  if (first === null) return null;
  const run = await ensurePipelineRun(deps.db, session.id, first);
  if (run.nextStep === "ask_context" && run.round === 0) {
    // Keep the round count of the context card the old pipeline wrote (no third question round).
    const stored = await getContextCard(deps.db, session.id);
    if (stored && (await advancePipelineRun(deps.db, session.id, "ask_context", "ask_context", { round: stored.round }))) {
      return { ...run, round: stored.round };
    }
  }
  return run;
}

/**
 * Runs the session's pipeline from its stored step until the context check pauses it, it finishes, or a step stops it.
 * Each step's move is compare-and-set on the run row (`advancePipelineRun`): a runner that loses it stops without
 * writing. A crash or throw leaves the row at the unfinished step, so a retried job re-runs only that step.
 *
 * `opts.resume` (the journalist's answer) is applied only when the run waits at `ask_context`. With `opts.round` (the
 * round the answer belongs to) it applies only when that equals the run's round: a redelivered older round is ignored,
 * and a retry inside the same round still applies. A matching round is applied even while the stage is still
 * `awaiting_context` (deliberate: it covers a send that committed but threw). Without a round (jobs queued before the
 * deploy, or sent by the route when there was no card) it applies only once the web has moved the stage off
 * `awaiting_context` (its route does so before sending the job). At any other step the run continues without it.
 */
export async function runPipeline(
  deps: PipelineDeps,
  sessionId: string,
  opts: { resume?: ResumePayload; round?: number } = {},
): Promise<"paused" | "done" | "stopped" | "ignored"> {
  const { db } = deps;
  const job = opts.resume ? "resume" : "start";
  const session = await getSession(db, sessionId);
  if (!session || session.stage === "failed") {
    console.log(`[pipeline] ignoring ${job} for ${sessionId}: ${session ? "the session failed" : "no such session"}`);
    return "ignored";
  }
  let run = await loadRun(deps, session, opts.resume);
  if (!run) {
    console.log(`[pipeline] ignoring ${job} for ${sessionId}: nothing to run at stage ${session.stage}`);
    return "ignored";
  }
  if (run.nextStep === "done") {
    console.log(`[pipeline] ignoring ${job} for ${sessionId}: already finished`);
    return "ignored";
  }
  let resume = run.nextStep === "ask_context" ? opts.resume : undefined;
  if (opts.resume && !resume) console.log(`[pipeline] resume for ${sessionId}: the run is at ${run.nextStep}; continuing without the answer`);
  if (resume && opts.round !== undefined && opts.round !== run.round) {
    console.log(`[pipeline] ignoring resume for ${sessionId}: it answers round ${opts.round}, the run is at round ${run.round}`);
    return "paused";
  }
  if (resume && opts.round === undefined && session.stage === "awaiting_context") {
    console.log(`[pipeline] ignoring resume for ${sessionId}: the context check is waiting for a new answer`);
    return "paused";
  }
  for (;;) {
    const step: PipelineStep = run.nextStep;
    if (step === "done") return "done";
    const result: StepResult = await STEPS[step](deps, run, resume);
    resume = undefined; // the answer belongs to the first step only, never to a later pause
    if ("pause" in result) {
      console.log(`[pipeline] ${sessionId} is waiting at the context check`);
      return "paused";
    }
    if ("stop" in result) return "stopped";
    if (STOPS_IF_FAILED.has(step) && (await getSession(db, sessionId))?.stage === "failed") return "stopped";
    // The pause is written with the move into it, in one transaction: the row never waits at ask_context with another stage.
    const pausing = result.next === "ask_context";
    const moved = await advancePipelineRun(db, sessionId, step, result.next, {
      ...(result.round !== undefined ? { round: result.round } : {}),
      ...(result.answers !== undefined ? { answers: result.answers } : {}),
      ...(pausing ? { stage: { stage: "awaiting_context" as const, progress: 55 } } : {}),
    });
    if (!moved) {
      console.log(`[pipeline] ${sessionId}: another run moved past ${step}; stopping`);
      return "stopped";
    }
    run = { ...run, nextStep: result.next, round: result.round ?? run.round, answers: result.answers ?? run.answers };
    if (pausing) return "paused";
  }
}
