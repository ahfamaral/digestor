import type { MomentChecks } from "@digestor/core";
import type { Golden } from "./metrics.js";

/**
 * Pure helpers of the model comparison (`scripts/batch-eval.ts`): run summaries, control moments and check scores.
 * Run-to-run noise on one model is large (README, Evaluation), so a model is described by the mean and range of
 * several runs, never by one.
 */

type Span = { startMs: number; endMs: number };
type Trap = Golden["traps"][number];
const overlaps = (a: Span, b: Span) => Math.min(a.endMs, b.endMs) > Math.max(a.startMs, b.startMs);

/** Mean, min and max of the values that exist (a failed run has none); null when none do. */
export function spread(values: (number | null | undefined)[]): { mean: number; min: number; max: number; n: number } | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v), n: v.length };
}

/** "12.3 (10–14)", or "12.3" for one run, or "n/a". */
export function fmtSpread(s: ReturnType<typeof spread>, digits = 1, unit = ""): string {
  if (!s) return "n/a";
  const f = (x: number) => `${x.toFixed(digits)}${unit}`;
  return s.n === 1 || s.min === s.max ? f(s.mean) : `${f(s.mean)} (${f(s.min)}–${f(s.max)})`;
}

/**
 * Control moments for the checks test: moments that overlap no trap, `n` of them spread evenly over the video
 * (sorted by start, every k-th), so a model that warns on everything is caught by a high control rate.
 */
export function pickControls<M extends Span>(moments: M[], traps: Span[], n: number): M[] {
  const free = moments.filter((m) => !traps.some((t) => overlaps(t, m))).sort((a, b) => a.startMs - b.startMs);
  if (free.length <= n) return free;
  const step = free.length / n;
  return Array.from({ length: n }, (_, i) => free[Math.floor(i * step)]!);
}

/** The warning a trap kind expects (the same reading as `trapHits`). */
export function warns(kind: Trap["kind"], c: MomentChecks): boolean {
  return kind === "mid_argument" ? !c.argumentComplete || c.continuesWith !== null : c.reportedSpeech;
}

/**
 * Per trap kind: traps fired (a checked moment overlapping the trap warns), the warning rate on moments that overlap
 * a trap of that kind, and the warning rate on the control moments. A good classifier fires on traps and rarely on
 * controls.
 */
export function checkScores(
  traps: Trap[],
  checked: (Span & { checks: MomentChecks | null })[],
  controls: (Span & { checks: MomentChecks | null })[],
): Record<Trap["kind"], { trapsFired: number; traps: number; trapMomentsWarned: number; trapMoments: number; controlsWarned: number; controls: number }> {
  const out = {} as ReturnType<typeof checkScores>;
  for (const kind of ["mid_argument", "quoted_opponent"] as const) {
    const of = traps.filter((t) => t.kind === kind);
    const onTrap = checked.filter((m) => m.checks && of.some((t) => overlaps(t, m)));
    const ctrl = controls.filter((m) => m.checks);
    out[kind] = {
      trapsFired: of.filter((t) => onTrap.some((m) => overlaps(t, m) && warns(kind, m.checks!))).length,
      traps: of.length,
      trapMomentsWarned: onTrap.filter((m) => warns(kind, m.checks!)).length,
      trapMoments: onTrap.length,
      controlsWarned: ctrl.filter((m) => warns(kind, m.checks!)).length,
      controls: ctrl.length,
    };
  }
  return out;
}
