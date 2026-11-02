import { closeMatches, personAt, type Attribution, type Granularity, type HighlightTypeId, type MomentChecks, type Person, type ProfileId, type Word } from "@digestor/core";

/** Hand-labelled expectations for one video (spec §14a). */
export interface Golden {
  sessionId?: string;
  videoPath?: string;
  profile: ProfileId;
  topics: { title: string; startMs: number; endMs: number }[];
  moments: { granularity: Granularity; startMs: number; endMs: number; types: HighlightTypeId[] }[];
  /** Who speaks when, by hand; `person: null` marks a stretch that is unclear and isn't scored. */
  speakers?: { startMs: number; endMs: number; person: string | null }[];
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

/**
 * Share of the speaking time inside the golden speaker spans that the stored attributions name correctly, wrongly or
 * not at all. Each word counts for its own length, resolved with `personAt` at the word's start. A word is
 * unnamed when its voice has no name, is anonymous or in conflict; spans with `person: null` are skipped.
 * A name is right when the golden name equals the person's display or full name once normalised, or when one
 * name's tokens are a subset of the other's (`closeMatches`, so "Tralli" matches "César Tralli").
 * `score = (correctMs - 5 * wrongMs) / totalMs`: a wrong name costs five times what a right one earns.
 */
export function attributionScore(
  golden: NonNullable<Golden["speakers"]>,
  words: Word[],
  atts: Attribution[],
  persons: Person[],
): { correctMs: number; wrongMs: number; unnamedMs: number; totalMs: number; correctConfirmedMs: number; score: number } {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const matches = (goldenName: string, p: Person) =>
    closeMatches(goldenName, [p]).length > 0 || (p.fullName !== null && closeMatches(goldenName, [{ ...p, displayName: p.fullName }]).length > 0);
  let correctMs = 0;
  let wrongMs = 0;
  let unnamedMs = 0;
  let correctConfirmedMs = 0;
  for (const span of golden) {
    if (span.person === null) continue;
    for (const w of words) {
      const ms = overlapMs(w, span);
      if (ms <= 0) continue;
      const res = personAt(atts, w.speaker, w.startMs);
      const p = res.kind === "named" ? byId.get(res.personId) : undefined;
      if (res.kind !== "named" || !p) unnamedMs += ms;
      else if (matches(span.person, p)) {
        correctMs += ms;
        if (res.confirmed) correctConfirmedMs += ms;
      } else wrongMs += ms;
    }
  }
  const totalMs = correctMs + wrongMs + unnamedMs;
  return { correctMs, wrongMs, unnamedMs, totalMs, correctConfirmedMs, score: totalMs === 0 ? 0 : (correctMs - 5 * wrongMs) / totalMs };
}
