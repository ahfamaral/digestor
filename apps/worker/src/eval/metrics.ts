import type { Granularity, HighlightTypeId, MomentChecks, ProfileId } from "@digestor/core";

/** Hand-labelled expectations for one video (spec §14a). */
export interface Golden {
  sessionId?: string;
  videoPath?: string;
  profile: ProfileId;
  topics: { title: string; startMs: number; endMs: number }[];
  moments: { granularity: Granularity; startMs: number; endMs: number; types: HighlightTypeId[] }[];
  traps: { kind: "mid_argument" | "quoted_opponent"; startMs: number; endMs: number }[];
}

type Span = { startMs: number; endMs: number };

function boundaries(topics: Span[]): number[] {
  return [...new Set(topics.flatMap((t) => [t.startMs, t.endMs]))];
}

/**
 * Distance from each golden topic boundary (every start and end) to the nearest boundary the analysis found.
 * No golden topics: 0. Golden topics but nothing found: Infinity.
 */
export function topicBoundaryError(golden: Span[], found: Span[]): { meanMs: number; maxMs: number } {
  const g = boundaries(golden);
  if (g.length === 0) return { meanMs: 0, maxMs: 0 };
  const f = boundaries(found);
  if (f.length === 0) return { meanMs: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY };
  const errors = g.map((b) => Math.min(...f.map((x) => Math.abs(x - b))));
  return { meanMs: errors.reduce((a, b) => a + b, 0) / errors.length, maxMs: Math.max(...errors) };
}

function overlapMs(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/**
 * How many golden moments of one granularity were found: a found moment of the same granularity must cover at
 * least `minOverlap` of the golden moment's length.
 */
export function momentRecall(
  golden: (Span & { granularity: Granularity })[],
  found: (Span & { granularity: Granularity })[],
  granularity: Granularity,
  minOverlap = 0.5,
): { found: number; total: number } {
  const g = golden.filter((m) => m.granularity === granularity);
  const f = found.filter((m) => m.granularity === granularity);
  const hits = g.filter((gm) => {
    const len = gm.endMs - gm.startMs;
    return len > 0 && f.some((fm) => overlapMs(gm, fm) / len >= minOverlap);
  });
  return { found: hits.length, total: g.length };
}

/**
 * How many typed golden moments were found with a matching highlight type: a found moment of the same granularity
 * covering at least `minOverlap` of the golden moment's length and carrying one of its types. Golden moments without
 * types aren't counted; a zero-length golden moment is counted but never found.
 */
export function highlightTypeRecall(
  golden: (Span & { granularity: Granularity; types: HighlightTypeId[] })[],
  found: (Span & { granularity: Granularity; highlights: { type: HighlightTypeId }[] })[],
  minOverlap = 0.5,
): { found: number; total: number } {
  const typed = golden.filter((g) => g.types.length > 0);
  const hits = typed.filter((gm) => {
    const len = gm.endMs - gm.startMs;
    return (
      len > 0 &&
      found.some(
        (fm) => fm.granularity === gm.granularity && overlapMs(gm, fm) / len >= minOverlap && fm.highlights.some((h) => gm.types.includes(h.type)),
      )
    );
  });
  return { found: hits.length, total: typed.length };
}

/**
 * A trap fires when a checked moment overlapping it carries the matching warning: `mid_argument` means the
 * argument-completeness check failed, `quoted_opponent` means reported speech was flagged. Moments whose checks
 * never ran count as not fired.
 */
export function trapHits(
  traps: (Span & { kind: "mid_argument" | "quoted_opponent" })[],
  checks: (Span & { checks: MomentChecks | null })[],
): { fired: number; total: number } {
  const fired = traps.filter((trap) =>
    checks.some((m) => {
      if (!m.checks || overlapMs(trap, m) <= 0) return false;
      return trap.kind === "mid_argument" ? !m.checks.argumentComplete || m.checks.continuesWith !== null : m.checks.reportedSpeech;
    }),
  );
  return { fired: fired.length, total: traps.length };
}

/** The moments `trapHits` can't judge yet: they overlap a trap but their checks never ran (`eval.ts --run-checks`). */
export function uncheckedOnTraps<M extends Span & { checks: MomentChecks | null }>(traps: Span[], moments: M[]): M[] {
  return moments.filter((m) => m.checks === null && traps.some((trap) => overlapMs(trap, m) > 0));
}
