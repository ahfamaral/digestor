/**
 * The heat of "Words used more than the chamber" (client-safe): a word's month share (its share of the target's words
 * that month over its share of the chamber's) becomes one of five levels. The page shows levels only, never the number.
 */
export type HeatLevel = "none" | "unused" | "about" | "more" | "muchMore";
export const HEAT_LEVELS: readonly HeatLevel[] = ["none", "unused", "about", "more", "muchMore"];

/**
 * At or above: "more" (half again the chamber's rate), "much more" (six times it). On the dev data (60 deputies with
 * enough text, their top words, compared with the rest of the chamber) a month splits about 33% not used, 2% about,
 * 14% more, 51% much more.
 */
export const HEAT_MORE = 1.5;
export const HEAT_MUCH_MORE = 6;

/** `null`: little or no speech text that month; 0: not said; below 1.5×: about the chamber's rate or less. */
export function heatLevel(share: number | null): HeatLevel {
  if (share === null) return "none";
  if (share <= 0) return "unused";
  if (share < HEAT_MORE) return "about";
  return share < HEAT_MUCH_MORE ? "more" : "muchMore";
}

/** "2026-01" … "2026-12"; with `today` ("YYYY-MM-DD"), months after today's are left out (none for a later year). */
export function yearMonths(year: number, today?: string): string[] {
  const all = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  return today ? all.filter((m) => m <= today.slice(0, 7)) : all;
}

/** One cell per month of `year` up to `today`'s; a month missing from `months` (no text in the chamber) is "none". */
export function heatRow(
  months: { month: string; share: number | null }[], year: number, today?: string,
): { month: string; level: HeatLevel }[] {
  const byMonth = new Map(months.map((m) => [m.month, m.share]));
  return yearMonths(year, today).map((month) => ({ month, level: heatLevel(byMonth.get(month) ?? null) }));
}
