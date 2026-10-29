// Transcription price per audio hour in USD. TODO: verify against vendor pricing.
export const USD_PER_HOUR = 0.40;

export function estimateCostUsd(durationMs: number): number {
  return Math.round((durationMs / 3_600_000) * USD_PER_HOUR * 100) / 100;
}
