/**
 * The audio-only picture, drawn in the browser as the render draws it (ffmpeg `showwaves` `mode=cline`): each column is
 * a vertical line centred on the middle, as tall as the sound is loud there. Pure helpers, so they can be tested.
 */

/**
 * One level (0–1) per column from a stretch of sound (time-domain, -1…1): the average size of the column's samples,
 * scaled so a pure tone reaches its peak (×π/2). It is what the render's waveform looks like at the preview's smaller
 * size: the voice's own waves, smooth, not a block of peaks.
 */
export function waveColumns(samples: ArrayLike<number>, columns: number): number[] {
  const out: number[] = [];
  if (columns <= 0 || samples.length === 0) return out;
  const per = samples.length / columns;
  for (let c = 0; c < columns; c++) {
    const from = Math.min(samples.length - 1, Math.floor(c * per));
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((c + 1) * per)));
    let sum = 0;
    for (let i = from; i < to; i++) sum += Math.abs(samples[i]!);
    out.push(Math.min(1, (sum / (to - from)) * (Math.PI / 2)));
  }
  return out;
}

/**
 * A still, speech-like waveform for previews where nothing plays ("Change look"): the same for the same width, so it
 * doesn't flicker on re-render. Values 0–1.
 */
export function sampleColumns(columns: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < columns; c++) {
    const x = c / Math.max(1, columns);
    // A voice-like wave (two tones) under a few syllable swells; never quite silent, never full scale.
    const envelope = 0.15 + 0.55 * Math.abs(Math.sin(x * Math.PI * 3.5));
    const wave = Math.abs(0.7 * Math.sin(c * 0.33) + 0.3 * Math.sin(c * 0.91));
    const v = envelope * wave;
    out.push(Math.max(0.02, Math.min(0.9, v)));
  }
  return out;
}

/** Each column's line as [x, top, height] in pixels, centred on the middle; at least 1 px so silence reads as a flat line. */
export function waveLines(columns: number[], width: number, height: number): [number, number, number][] {
  const mid = height / 2;
  const step = columns.length > 0 ? width / columns.length : 0;
  return columns.map((v, i) => {
    const h = Math.max(1, v * height);
    return [i * step, mid - h / 2, h];
  });
}
