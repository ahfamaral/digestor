import type { Boundary, Range } from "@digestor/core";

/** Pause padding `snapRange` applies around a sentence boundary (core `snap.ts`); kept equal so client snaps match. */
const SNAP_PAD_MS = 150;
/** Shortest clip the trim handles allow. */
export const MIN_CLIP_MS = 1000;

export interface TrimView {
  viewStart: number;
  viewEnd: number;
  /** Position in the strip, 0–100. */
  toPct: (ms: number) => number;
  /** Time at a strip position; positions outside 0–100 clamp to the strip's edges. */
  toMs: (pct: number) => number;
}

/** The zoomed strip around a clip: the clip ± `padMs`, clamped to the video. */
export function trimView(clip: Range, durationMs: number, padMs = 30_000): TrimView {
  const viewStart = Math.max(0, clip.startMs - padMs);
  const viewEnd = Math.max(viewStart, Math.min(durationMs, clip.endMs + padMs));
  const span = Math.max(1, viewEnd - viewStart);
  return {
    viewStart,
    viewEnd,
    toPct: (ms) => ((ms - viewStart) / span) * 100,
    toMs: (pct) => viewStart + (Math.min(100, Math.max(0, pct)) / 100) * (viewEnd - viewStart),
  };
}

/** The closest boundary to `ms`, or null when none is within `maxDistMs` (ties keep the earlier one). */
export function nearestBoundary(boundaries: number[], ms: number, maxDistMs = 2000): number | null {
  let best: number | null = null;
  for (const b of boundaries) {
    const d = Math.abs(b - ms);
    if (d <= maxDistMs && (best === null || d < Math.abs(best - ms))) best = b;
  }
  return best;
}

/**
 * One keyboard step of a handle. Without snapping it moves by `deltaMs`; with snapping it jumps to the nearest cut point
 * at least one step away in that direction, or by the plain step when there is no pause that way.
 */
export function stepHandle(points: number[], ms: number, deltaMs: number, snap: boolean): number {
  const target = ms + deltaMs;
  if (!snap) return target;
  const ahead = points.filter((p) => (deltaMs > 0 ? p >= target : p <= target));
  if (ahead.length === 0) return target;
  return deltaMs > 0 ? Math.min(...ahead) : Math.max(...ahead);
}

/** Keeps a handle inside the strip and at least `MIN_CLIP_MS` from the other handle. */
export function clampHandle(
  which: "start" | "end",
  ms: number,
  clip: Range,
  view: Pick<TrimView, "viewStart" | "viewEnd">,
): number {
  if (which === "start") return Math.max(view.viewStart, Math.min(ms, clip.endMs - MIN_CLIP_MS));
  return Math.min(view.viewEnd, Math.max(ms, clip.startMs + MIN_CLIP_MS));
}

/**
 * Where a cut may start and end inside `[fromMs, toMs]`, as plain numbers: exactly the positions `snapRange` gives for
 * each sentence boundary (a start just before the next word, an end just after the last one). Server-side helper;
 * the transcript itself never reaches the client.
 */
export function cutPoints(boundaries: Boundary[], fromMs: number, toMs: number): { starts: number[]; ends: number[] } {
  const inside = (ms: number) => ms >= fromMs && ms <= toMs;
  const starts = boundaries
    .slice(0, -1)
    .map((b) => Math.max(b.afterWordEndMs, b.beforeWordStartMs - SNAP_PAD_MS))
    .filter(inside);
  const ends = boundaries
    .slice(1)
    .map((b) => Math.min(b.beforeWordStartMs, b.afterWordEndMs + SNAP_PAD_MS))
    .filter(inside);
  return { starts, ends };
}
