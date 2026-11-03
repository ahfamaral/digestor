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
