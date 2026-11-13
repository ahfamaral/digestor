import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import type { RecordMeaning } from "@/lib/monitor/search";

const KEYS = {
  votes: { used: "votes.meaningUsed", best: "votes.bestFirst", unavailable: "votes.meaningUnavailable" },
  bills: { used: "bills.meaningUsed", best: "bills.bestFirst", unavailable: "bills.meaningUnavailable" },
} as const;

/**
 * Under a deputy's vote or bill text box, when it was also searched by meaning: why some rows are marked "related by
 * meaning" (`marked`), else that the closest matches come first; or, with the worker down, that only the words were
 * searched. Nothing for exact words or no text.
 */
export function MeaningNote({ locale, section, meaning, marked }: { locale: MonitorLocale; section: "votes" | "bills"; meaning?: RecordMeaning; marked: boolean }) {
  if (!meaning || meaning === "off") return null;
  const k = KEYS[section];
  return <p className="px-1 text-sm text-muted-foreground">{tm(locale, meaning === "unavailable" ? k.unavailable : marked ? k.used : k.best)}</p>;
}

/** The pill on a row only the search by meaning found (the speech search's own label). */
export function ByMeaning({ locale }: { locale: MonitorLocale }) {
  return <span className="rounded-full border border-border px-2 py-px text-xs text-muted-foreground">{tm(locale, "speech.byMeaning")}</span>;
}
