// Transcription price per audio hour in USD. TODO: verify against vendor pricing.
export const USD_PER_HOUR = 0.40;
/** Reading on-screen captions: about 60 `fast` image calls per video session (measured on the debate, see the speaker-names spec). */
export const CAPTIONS_USD = 0.10;

export function estimateCostUsd(durationMs: number, opts: { captions?: boolean } = {}): number {
  const usd = (durationMs / 3_600_000) * USD_PER_HOUR + (opts.captions ? CAPTIONS_USD : 0);
  return Math.round(usd * 100) / 100;
}
