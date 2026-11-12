import type { TimelineBand } from "@digestor/core";
import { formatDay, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { cn } from "@/lib/utils";

const START = "2023-02-01";
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** Neutral greys only: colour is reserved for highlight types. Consecutive parties alternate two greys. */
const GREYS = ["bg-stone-200", "bg-stone-300"];
/** One grey per band: consecutive in-office parties alternate the two greys (out-of-office gaps keep the last one). */
function shadesOf(bands: TimelineBand[]): string[] {
  let grey = 0;
  let lastParty: string | null | undefined;
  return bands.map((b) => {
    if (b.inOffice && b.party !== lastParty) {
      if (lastParty !== undefined) grey = 1 - grey;
      lastParty = b.party;
    }
    return GREYS[grey]!;
  });
}
const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, var(--border) 0 3px, transparent 3px 7px)" };

/**
 * The deputy's party and in-office state since 1 Feb 2023, from the official history: a list with every date (all
 * widths), and from `sm` up a bar above it drawing the same bands by days, with year ticks and out-of-office stretches
 * as hatched gaps (a picture of the list, hidden from screen readers). Nothing without history.
 */
export function PartyTimeline({ locale, bands, today }: { locale: MonitorLocale; bands: TimelineBand[]; today: string }) {
  if (bands.length === 0) return null;
  const start = dayMs(START);
  const span = Math.max(1, dayMs(today) - start);
  const pct = (d: string) => Math.min(100, Math.max(0, ((dayMs(d) - start) / span) * 100));
  const day = (d: string) => formatDay(d, locale);
  const label = (b: TimelineBand) => {
    const when = b.to === null ? tm(locale, "timeline.since", { date: day(b.from) }) : tm(locale, "timeline.range", { from: day(b.from), to: day(b.to) });
    const who = b.inOffice ? [b.party, b.uf].filter(Boolean).join("-") || "—" : tm(locale, "timeline.outOfOffice");
    return [who, when, b.inOffice ? "" : b.description].filter(Boolean).join(" · ");
  };
  const shades = shadesOf(bands);
  const years: number[] = [];
  for (let y = Number(START.slice(0, 4)) + 1; `${y}-01-01` <= today; y++) years.push(y);
  return (
    <section className="grid gap-2" aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="text-base font-semibold">{tm(locale, "timeline.title")}</h2>
      <div aria-hidden className="hidden sm:block">
        <div className="flex h-9 overflow-hidden rounded-lg border border-border bg-white">
          {bands.map((b, i) => {
            const width = pct(b.to ?? today) - pct(b.from);
            if (width <= 0) return null;
            return b.inOffice ? (
              <div key={i} title={label(b)} style={{ width: `${width}%` }} className={cn("flex min-w-0 items-center border-r border-white px-1.5 text-xs font-semibold", shades[i])}>
                <span className="truncate">{b.party}</span>
              </div>
            ) : (
              <div key={i} title={label(b)} style={{ width: `${width}%`, ...HATCH }} className="min-w-1 border-r border-white bg-white" />
            );
          })}
        </div>
        <div className="relative h-5 font-mono text-xs text-muted-foreground">
          {years.map((y) => (
            <span key={y} style={{ left: `${pct(`${y}-01-01`)}%` }} className="absolute top-1 -translate-x-1/2 border-l border-border pl-1">
              {y}
            </span>
          ))}
        </div>
      </div>
      <ul className="grid gap-1 text-sm sm:flex sm:flex-wrap sm:gap-1.5 sm:text-xs">
        {bands.map((b, i) => (
          <li key={i} className={cn("rounded-md px-2 py-1", b.inOffice ? shades[i] : "border border-dashed border-border bg-white")}>
            {label(b)}
          </li>
        ))}
      </ul>
    </section>
  );
}
