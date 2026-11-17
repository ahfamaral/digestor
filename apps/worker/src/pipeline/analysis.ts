import {
  topHighlights,
  type ContextCard,
  type Moment,
  type MomentWithHighlights,
  type ProfileId,
  type Word,
} from "@digestor/core";
import {
  completeAnalysisVersion,
  getContextCard,
  getRunningAnalysis,
  getSession,
  getTranscript,
  saveBriefing,
  saveMoments,
  saveTopics,
  setMomentChecks,
  setMomentThumb,
  setStage,
  settlePreview,
  startAnalysisVersion,
  updateSession,
  type Db,
  type LocalStorage,
  type Session,
  type Stage,
} from "@digestor/core/server";
import { writeBriefing } from "../agents/briefing.js";
import { checkMoment } from "../agents/checks.js";
import { findMoments } from "../agents/moments.js";
import { findTopics } from "../agents/topics.js";
import { MissingApiKeyError } from "../errors.js";
import { MODEL_IDS, type LLMModel, type StructuredLLM } from "../llm/structured.js";
import { UsageMeter, withUsageMeter } from "../llm/usage.js";
import { releaseAudio } from "./audio.js";
import { promptCard } from "./naming.js";

/** Bump a version when its prompt changes; every analysis version records the set it ran with. */
export const PROMPT_VERSIONS = {
  topics: "topics@1",
  moments: "moments@1",
  punchlines: "punchlines@2", // per-exchange cap, and stretches between exchanges
  briefing: "briefing@1",
  checks: "checks@1",
} as const;

/** Model id per step, recorded on every analysis version (`ids` as the LLM reports them, provider-qualified). */
export const analysisModels = (ids: Record<LLMModel, string>) => ({
  topics: ids.reasoning,
  moments: ids.reasoning,
  punchlines: ids.reasoning,
  briefing: ids.reasoning,
  checks: ids.fast,
});

/** The steps' models with the default provider (Anthropic). */
export const ANALYSIS_MODELS = analysisModels(MODEL_IDS);

/** Evidence marker for a profile the user picked (same marker the context step uses). */
const USER_SET_EVIDENCE = "set by user";

export type AnalysisDeps = {
  db: Db;
  storage: LocalStorage;
  llm: StructuredLLM;
  media: { thumbnail(input: string, atMs: number, output: string): Promise<unknown> };
};

/** The stored context card with the analysis profile when it differs (a re-analysis); prompts then project names with `promptCard`. */
export function withProfile(card: ContextCard, profile: ProfileId): ContextCard {
  return card.profile.value === profile ? card : { ...card, profile: { value: profile, confidence: 1, evidence: USER_SET_EVIDENCE } };
}

/** The session's video for stills, or null for an audio-only session or a video removed by retention. */
function videoKeyOf(session: Session): string | null {
  if (!session.hasVideo || session.videoDeletedAt) return null;
  return session.proxyKey ?? session.originalKey;
}

/**
 * Checks and a thumbnail for each top highlight. A failed check or thumbnail is logged and skipped; a missing API key
 * is not (Ruling R8): it escapes and fails the run.
 */
async function prepareTopHighlights(
  deps: AnalysisDeps,
  a: { session: Session; card: ContextCard; words: Word[]; moments: Moment[] },
): Promise<void> {
  const { db, storage } = deps;
  const videoKey = videoKeyOf(a.session);
  for (const m of a.moments) {
    try {
      await setMomentChecks(db, m.id, await checkMoment(deps.llm, { card: a.card, moment: m, words: a.words }));
    } catch (err) {
      if (err instanceof MissingApiKeyError) throw err;
      console.error(`[analysis] checks failed for moment ${m.id}; continuing without them:`, err);
    }
    if (!videoKey) continue;
    const key = storage.key(a.session.id, `thumbs/${m.id}.jpg`);
    try {
      await deps.media.thumbnail(storage.resolve(videoKey), Math.round((m.startMs + m.endMs) / 2), storage.resolve(key));
      await setMomentThumb(db, m.id, key);
    } catch (err) {
      console.error(`[analysis] thumbnail failed for moment ${m.id}; continuing without it:`, err);
    }
  }
}

/**
 * Runs one analysis version: topics → moments → briefing → checks and thumbnails of the top highlights → complete.
 *
 * - The first analysis (session not `ready` yet) walks the stages finding_topics 75 → finding_moments 82 →
 *   writing_briefing 92 → preparing_preview 96 → ready 100 (once the preview copy is done too, see `settlePreview`). A re-analysis of a `ready` session never touches the stage: the session stays
 *   readable on its current version and the new version's `running` status carries the progress.
 * - Safe to run again after a crash: `startAnalysisVersion` reuses the session's `running` version (same number) and
 *   clears what the crashed run had saved.
 * - Errors propagate and leave the version `running`, so a pg-boss retry reuses it. The job layer, which knows the
 *   attempt, fails the version when it gives up (deterministic error or final attempt; see `jobs.ts`).
 * - On success `sessions.profile` follows the profile of the new current version.
 */
export async function runAnalysis(deps: AnalysisDeps, sessionId: string, opts: { profile: ProfileId; reason: string; analysisId?: string }): Promise<void> {
  const { db, llm } = deps;
  const [session, loaded, stored] = await Promise.all([
    getSession(db, sessionId),
    getTranscript(db, sessionId),
    getContextCard(db, sessionId),
  ]);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!loaded) throw new Error(`Session ${sessionId} has no transcript`);
  // AssemblyAI rounds its duration up to the next second: never snap or place a moment past the video's own end
  // (a clip ending there couldn't be trimmed).
  const transcript = session.durationMs ? { ...loaded, durationMs: Math.min(loaded.durationMs, session.durationMs) } : loaded;
  if (!stored) throw new Error(`Session ${sessionId} has no context card`);
  const initial = session.stage !== "ready";
  const stage = async (s: Stage, progress: number) => {
    if (initial) await setStage(db, sessionId, s, progress);
  };
  if (opts.analysisId) {
    // A version claimed by the web route: only fill it while it is still this session's running one.
    const claimed = await getRunningAnalysis(db, sessionId);
    if (claimed?.id !== opts.analysisId) {
      console.log(`Ignoring analysis ${opts.analysisId} of ${sessionId}: it is no longer running`);
      return;
    }
  }
  const version = await startAnalysisVersion(db, sessionId, {
    profile: opts.profile,
    reason: opts.reason,
    models: analysisModels(llm.modelIds ?? MODEL_IDS),
    promptVersions: { ...PROMPT_VERSIONS },
  });
  // Names in every prompt are the current attributions, not the card's own (spec §6.1). Read after the version's
  // `names_at` stamp, so they are never older than it.
  const card = await promptCard(db, sessionId, withProfile(stored.card, opts.profile));

  // Every LLM call of this run (retries included) adds its tokens and dollars here; stored on the version.
  const meter = new UsageMeter();
  await withUsageMeter(meter, async () => {
    await stage("finding_topics", 75);
    const drafts = await findTopics(llm, { card, transcript });
    const topics = await saveTopics(db, version.id, drafts.map((t, idx) => ({ idx, ...t })));

    await stage("finding_moments", 82);
    const found = await findMoments(llm, { card, transcript, topics });
    const saved = await saveMoments(db, version.id, found);

    await stage("writing_briefing", 92);
    await saveBriefing(db, version.id, await writeBriefing(llm, { card, topics, moments: saved, words: transcript.words }));

    const withHighlights: MomentWithHighlights[] = saved.map((m, i) => ({ ...m, highlights: found[i]!.highlights }));
    const top = [...new Set(topHighlights(withHighlights, opts.profile).map((h) => h.moment))];
    await prepareTopHighlights(deps, { session, card, words: transcript.words, moments: top });
  });

  await completeAnalysisVersion(db, version.id, { usage: meter.report() });
  await updateSession(db, sessionId, {
    profile: opts.profile,
    ...(initial ? { stage: "preparing_preview" as const, progress: 96, error: null } : {}),
  });
  // The first analysis waits for the preview copy (its own job): whichever of the two ends last makes the session ready.
  if (initial) {
    await settlePreview(db, sessionId);
    await releaseAudio({ db, storage: deps.storage }, sessionId); // only once the join made it ready
  }
}
