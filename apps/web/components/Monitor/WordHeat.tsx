import type { DistinctiveWord } from "@digestor/core/server";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { HEAT_LEVELS, heatRow, yearMonths, type HeatLevel } from "@/lib/monitor/wordHeat";

/** The section's anchor (the deputy page's "On this page" row links here). */
export const WORDS_SECTION = "words";

/**
 * One neutral ramp (colour is not a judgement here): a hatched square for little or no text, an outlined white square
 * for "not used", then three greys getting darker. Every cell also carries its level as text (screen readers, and
 * the hover title), and the key below spells the levels out.
 */
const CELL: Record<HeatLevel, string> = {
  none: "bg-[repeating-linear-gradient(135deg,var(--color-stone-300)_0_1px,transparent_1px_4px)]",
  unused: "border border-stone-400 bg-white",
  about: "bg-stone-400",
  more: "bg-stone-600",
  muchMore: "bg-stone-900",
};

/** The party view's Suspense fallback: the heading and a quiet status while the words are counted. */
export function WordHeatLoading({ locale }: { locale: MonitorLocale }) {
  return (
    <section className="grid gap-2" aria-labelledby="words-title">
      <h2 id="words-title" className="text-base font-semibold">{tm(locale, "words.title")}</h2>
      <p role="status" className="text-sm text-muted-foreground">{tm(locale, "words.counting")}</p>
    </section>
  );
}

/**
 * "Words used more than the chamber": up to 20 words a deputy (or a party's speeches) uses more than the rest of the
 * chamber, each with a month-by-month heat row for `year`. Counting only, no AI; no numbers, scores or comparisons
 * between deputies. Below the minimum of text it says so instead of showing noisy words. `party`: the party view's note.
 * `today` ("YYYY-MM-DD"): months after it aren't drawn.
 */
export function WordHeat({
  locale, result, year, party, today,
}: { locale: MonitorLocale; result: { enough: boolean; words: DistinctiveWord[] }; year: number; party?: string; today?: string }) {
  const months = yearMonths(year, today).map((m) => new Date(`${m}-01T00:00:00Z`));
  const monthName = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const monthLetter = new Intl.DateTimeFormat(locale, { month: "narrow", timeZone: "UTC" });
  return (
    <section id={WORDS_SECTION} tabIndex={-1} className="grid scroll-mt-14 gap-2 outline-none" aria-labelledby="words-title">
      <h2 id="words-title" className="text-base font-semibold">{tm(locale, "words.title")}</h2>
      {party && <p className="text-xs text-muted-foreground">{tm(locale, "words.partyNote", { party })}</p>}
      {!result.enough ? (
        <p className="text-sm text-muted-foreground">{tm(locale, "words.notEnough")}</p>
      ) : result.words.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tm(locale, "words.none")}</p>
      ) : (
        <div className="grid gap-3 rounded-xl border border-border bg-white px-3 py-3 sm:px-4">
          <table className="w-full border-separate border-spacing-x-0.5 border-spacing-y-1 text-sm sm:w-auto sm:justify-self-start sm:border-spacing-x-1">
            <caption className="sr-only">{tm(locale, "words.tableCaption", { year })}</caption>
            <thead>
              <tr>
                <th scope="col" className="sr-only">{tm(locale, "words.word")}</th>
                {months.map((d) => (
                  <th key={d.toISOString()} scope="col" className="w-3.5 p-0 text-center font-mono text-[10px] font-normal text-muted-foreground sm:w-5 sm:text-xs lg:w-9">
                    <abbr title={monthName.format(d)} className="no-underline">
                      <span aria-hidden>{monthLetter.format(d)}</span>
                      <span className="sr-only">{monthName.format(d)}</span>
                    </abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.words.map((w) => (
                <tr key={w.stem}>
                  <th scope="row" lang="pt-BR" className="max-w-0 truncate pr-2 text-left font-medium sm:max-w-none sm:min-w-48 sm:pr-4" title={w.label}>
                    {w.label}
                  </th>
                  {heatRow(w.months, year, today).map((c, i) => {
                    const text = tm(locale, "words.cell", { month: monthName.format(months[i]!), level: tm(locale, `words.level.${c.level}`) });
                    return (
                      <td key={c.month} className="p-0" title={text}>
                        <span aria-hidden className={`block h-3.5 w-3.5 rounded-[3px] sm:h-5 sm:w-5 lg:h-6 lg:w-9 ${CELL[c.level]}`} />
                        <span className="sr-only">{text}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-1.5">
            <p className="sr-only">{tm(locale, "words.legend")}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {HEAT_LEVELS.map((level) => (
                <li key={level} className="flex items-center gap-1.5">
                  <span aria-hidden className={`block size-3 shrink-0 rounded-[3px] ${CELL[level]}`} />
                  {tm(locale, `words.level.${level}`)}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">{tm(locale, "words.counted")}</p>
          <details className="text-sm">
            <summary className="w-fit cursor-pointer rounded font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-stone-500">
              {tm(locale, "words.how")}
            </summary>
            <div className="mt-2 grid gap-2 text-muted-foreground">
              <p>{tm(locale, "words.howSplit")}</p>
              <p>{tm(locale, "words.howRank")}</p>
              <p>{tm(locale, "words.howHeat")}</p>
              <p>{tm(locale, "words.howNot")}</p>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
