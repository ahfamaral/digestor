/**
 * AssemblyAI per audio hour: Universal-3.5 Pro $0.21 + speaker labels $0.02 (pricing page, checked 2026-11-03; the
 * Senado transcript reported `speech_model_used: universal-3-5-pro`). We send no `speech_models`, so the account's
 * default model decides; change this if that default changes.
 */
export const TRANSCRIPTION_USD_PER_HOUR = 0.23;
/**
 * Context check + full analysis per audio hour, as measured on OpenRouter with Claude Haiku 5.5: the 2 h debate cost
 * $0.13–0.15 per run (≈ $0.07/h), the 5.3 h Senado session at most $0.21 (≈ $0.04/h). The higher figure is used.
 */
export const ANALYSIS_USD_PER_HOUR = 0.07;
/** Reading on-screen captions: a conservative ceiling for up to 60 `fast` image calls per video session. The debate measured $0.002 for 18 calls (about $0.007 for 60). */
export const CAPTIONS_USD = 0.10;

export function estimateCostUsd(durationMs: number, opts: { captions?: boolean } = {}): number {
  const usd = (durationMs / 3_600_000) * (TRANSCRIPTION_USD_PER_HOUR + ANALYSIS_USD_PER_HOUR) + (opts.captions ? CAPTIONS_USD : 0);
  return Math.round(usd * 100) / 100;
}

// ---------------------------------------------------------------------------------------------------------------------
// Spending control (2026-11-16): estimates shown before paid actions, and what a session has cost so far. Every figure
// is an estimate unless it says "recorded"; the bases below are the measured runs in docs/capstone/evaluation.md
// (OpenRouter, Claude Haiku 5.5 for both the reasoning and the fast model, as configured on 2026-11-16).
// ---------------------------------------------------------------------------------------------------------------------

/** Transcription plus analysis per hour of video: the rate quoted before a YouTube link is downloaded ($0.30). */
export const PROCESSING_USD_PER_HOUR = TRANSCRIPTION_USD_PER_HOUR + ANALYSIS_USD_PER_HOUR;

/**
 * One Ask question on one video. Measured: 12 questions cost $0.038 and $0.035 (C1+C2 runs, judge calls included,
 * evaluation.md), about $0.003 each; a question that needs several tool turns costs more, so $0.01 is a ceiling.
 */
export const ASK_USD_PER_QUESTION = 0.01;

/**
 * One "Ask across videos" question. Not measured: a routing call, then one answer over up to 5 videos' passages and one
 * verify judge per cited video (all on the fast model), about 3 to 5 single-video questions' worth; rounded up.
 */
export const LIBRARY_ASK_USD_PER_QUESTION = 0.02;

/**
 * Translating subtitle lines, per minute of clip. Not metered (subtitle jobs run outside a usage meter): a minute of
 * speech is about 20 lines, so about 500 input and 400 output tokens plus thinking (say 1,500 output in all) on the fast
 * model at Haiku 5.5 prices ($0.10 / $0.50 per million tokens), about $0.001; doubled to stay conservative. A subtitle
 * track in the video's own language makes no model call and costs nothing.
 */
export const TRANSLATION_USD_PER_CLIP_MINUTE = 0.002;

/**
 * One "Find more" run: a single reasoning-model call over at most 160,000 characters of transcript (about 40,000
 * tokens, `FIND_MORE_MAX_CHARS`) and up to 20 moments back. At Haiku 5.5 prices that is about $0.008 at the cap; with
 * Claude Sonnet 5.5 as the reasoning model it would be about $0.15. Not metered.
 */
export const FIND_MORE_USD = 0.01;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * A new analysis of a video already transcribed ("Something's off", re-analysis): the analysis share only. The worker's
 * reanalyze job runs `runAnalysis` on the stored transcript and never transcribes again.
 */
export function estimateReanalysisUsd(durationMs: number): number {
  return Math.max(0, durationMs / HOUR_MS) * ANALYSIS_USD_PER_HOUR;
}

/** Subtitle translation for clips of this total length; 0 when the subtitles are in the video's own language. */
export function estimateTranslationUsd(clipMs: number, translated = true): number {
  return translated ? Math.max(0, clipMs / MINUTE_MS) * TRANSLATION_USD_PER_CLIP_MINUTE : 0;
}

/**
 * US$ per million tokens, input / output, for usage stored with tokens but no dollars (all its calls unpriced). Checked
 * 2026-11-16 against https://platform.claude.com/docs/en/about-claude/pricing (the worker's `ANTHROPIC_PRICES`
 * repeats the Anthropic rows; OpenRouter passes Anthropic's prices through). Keys are normalised by `priceKey`.
 */
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

/** "openrouter:anthropic/claude-haiku-5.5" or "claude-haiku-5-5-20261001" → "claude-haiku-5-5". */
export function priceKey(model: string): string {
  const bare = model.replace(/^openrouter:/, "").split("/").pop() ?? model;
  return bare.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
}

export interface RecordedCost {
  /** Dollars the stored usage holds, plus fully unpriced models priced from their tokens by the table above. */
  usd: number;
  calls: number;
  /** Calls with neither a recorded cost nor a known price: left out of `usd`. */
  unpricedCalls: number;
}

type UsageEntry = { calls: number; inputTokens: number; outputTokens: number; costUsd: number; unpricedCalls: number };

/** What a stored `LLMUsage` (per model) adds up to. A model whose every call went unpriced is priced from its tokens. */
export function recordedCost(usage: Record<string, UsageEntry> | null | undefined): RecordedCost {
  let usd = 0;
  let calls = 0;
  let unpricedCalls = 0;
  for (const [model, u] of Object.entries(usage ?? {})) {
    calls += u.calls;
    const price = MODEL_PRICES_USD_PER_MTOK[priceKey(model)];
    if (u.unpricedCalls > 0 && u.unpricedCalls === u.calls && u.costUsd === 0 && price) {
      usd += (u.inputTokens * price.input + u.outputTokens * price.output) / 1e6;
    } else {
      usd += u.costUsd;
      unpricedCalls += u.unpricedCalls;
    }
  }
  return { usd, calls, unpricedCalls };
}

export interface SpendingInput {
  /** The video's length; null while unknown. */
  durationMs: number | null;
  /** The session has a picture (on-screen captions are read). */
  hasVideo: boolean;
  /** A transcript was stored, so AssemblyAI was paid. */
  transcribed: boolean;
  /** Every analysis version, complete, running or failed (each run was paid). */
  analyses: { usage: Record<string, UsageEntry> | null | undefined }[];
}

export interface Spending {
  /** What the pipeline should have cost: transcription (+ captions) once, plus the analysis estimate per version. */
  estimatedUsd: number;
  /** Transcription (+ captions), always an estimate: AssemblyAI is not metered by the app. */
  transcriptionUsd: number;
  /** LLM dollars the analysis versions recorded (versions from 2026-11-10 on). */
  recordedUsd: number;
  /** Versions that recorded usage. */
  meteredAnalyses: number;
  /** Versions with no usage stored (older, or still running): their share in `bestUsd` is estimated. */
  unmeteredAnalyses: number;
  unpricedCalls: number;
  /** Recorded where it exists, estimated elsewhere: the best figure for "spent so far". */
  bestUsd: number;
}

/** What one session has cost (pipeline and analyses only; Ask, checks, Find more and subtitles aren't metered). */
export function sessionSpending(s: SpendingInput): Spending {
  const ms = s.durationMs ?? 0;
  const transcriptionUsd = s.transcribed ? (ms / HOUR_MS) * TRANSCRIPTION_USD_PER_HOUR + (s.hasVideo ? CAPTIONS_USD : 0) : 0;
  const perAnalysis = (ms / HOUR_MS) * ANALYSIS_USD_PER_HOUR;
  let recordedUsd = 0;
  let metered = 0;
  let unpricedCalls = 0;
  for (const a of s.analyses) {
    const r = recordedCost(a.usage);
    if (r.calls > 0) {
      metered += 1;
      recordedUsd += r.usd;
      unpricedCalls += r.unpricedCalls;
    }
  }
  const unmetered = s.analyses.length - metered;
  return {
    estimatedUsd: transcriptionUsd + perAnalysis * s.analyses.length,
    transcriptionUsd,
    recordedUsd,
    meteredAnalyses: metered,
    unmeteredAnalyses: unmetered,
    unpricedCalls,
    bestUsd: transcriptionUsd + recordedUsd + perAnalysis * unmetered,
  };
}

/** Totals over sessions (the Sessions page's "Spent so far"). */
export function totalSpending(rows: Spending[]): { bestUsd: number; recordedUsd: number; estimatedPartUsd: number } {
  const bestUsd = rows.reduce((n, r) => n + r.bestUsd, 0);
  const recordedUsd = rows.reduce((n, r) => n + r.recordedUsd, 0);
  return { bestUsd, recordedUsd, estimatedPartUsd: Math.max(0, bestUsd - recordedUsd) };
}

/**
 * A dollar amount for an estimate's label: `{ under: true }` below half a cent (shown as "under $0.01"), else the
 * amount to two decimals ("0.42"), or three below ten cents for a recorded figure that needs them (`precise`).
 */
export function usdAmount(usd: number, opts: { precise?: boolean } = {}): { under: boolean; amount: string } {
  if (!Number.isFinite(usd) || usd < 0.005) return { under: true, amount: "0.01" };
  if (opts.precise && usd < 0.1) return { under: false, amount: usd.toFixed(3) };
  return { under: false, amount: usd.toFixed(2) };
}
