import Link from "next/link";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import type { RecordMeaning } from "@/lib/monitor/search";

const KEYS = {
  votes: { used: "votes.meaningUsed", noWords: "votes.meaningNoWords", best: "votes.bestFirst", unavailable: "votes.meaningUnavailable" },
  bills: { used: "bills.meaningUsed", noWords: "bills.meaningNoWords", best: "bills.bestFirst", unavailable: "bills.meaningUnavailable" },
} as const;

/**
 * Under a deputy's vote or bill text box, right above the list: with rows only the search by meaning found
 * (`meaningOnly`), that they follow the word matches and may not be about the topic (or, with no word match at all,
 * that none uses the words and these are only the closest); with none, that the best matches come first; with the
 * worker down, that only the words were searched. Nothing without a text, or while the rows are held back (`hidden`).
 */
export function MeaningNote({
  locale, section, meaning, words, meaningOnly, hidden = 0,
}: { locale: MonitorLocale; section: "votes" | "bills"; meaning?: RecordMeaning; words: number; meaningOnly: number; hidden?: number }) {
  // rows held back (`MeaningHeld` is the empty state then): nothing to say above an empty list
  if (!meaning || meaning === "off" || hidden > 0) return null;
  const k = KEYS[section];
  const key = meaning === "unavailable" ? k.unavailable : meaning === "used" && meaningOnly > 0 ? (words === 0 ? k.noWords : k.used) : k.best;
  return <p className="px-1 text-sm text-muted-foreground">{tm(locale, key)}</p>;
}

/**
 * The empty state of a vote or bill text box with no word match while the search by meaning found close rows
 * (`hidden`: how many, held back because they may be unrelated): says no row uses the words, and links to them
 * (`showHref`: the page with `vmeaning=1` / `bmeaning=1`).
 */
export function MeaningHeld({
  locale, section, hidden, showHref,
}: { locale: MonitorLocale; section: "votes" | "bills"; hidden: number; showHref: string }) {
  return (
    <>
      {tm(locale, `${section}.noWords`)}{" "}
      <Link
        href={showHref}
        className="rounded font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
      >
        {hidden === 1 ? tm(locale, `${section}.showMeaningOne`) : tm(locale, `${section}.showMeaning`, { n: formatCount(hidden, locale) })}
      </Link>
    </>
  );
}

/** After "N of M …" when rows only the search by meaning found are listed too: they are never counted as matches. */
export function MeaningCount({ locale, n }: { locale: MonitorLocale; n: number }) {
  return n > 0 ? <> · {tm(locale, "votes.meaningCount", { n: formatCount(n, locale) })}</> : null;
}

/** The pill on a row only the search by meaning found: close in meaning, maybe not about the topic. */
export function ByMeaning({ locale }: { locale: MonitorLocale }) {
  return <span className="rounded-full border border-dashed border-border px-2 py-px text-xs text-muted-foreground">{tm(locale, "votes.closeInMeaning")}</span>;
}
