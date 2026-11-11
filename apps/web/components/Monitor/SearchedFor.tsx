import { Loader2 } from "lucide-react";
import type { Searched } from "@/lib/monitor/search";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";

/** What was actually searched: every term, the query it came from when translated, a notice when translation failed. */
export function SearchedFor({ locale, searched }: { locale: MonitorLocale; searched: Searched }) {
  if (!searched.q) return null;
  return (
    <div role="status" className="grid gap-1 text-sm text-muted-foreground">
      <p>
        {tm(locale, "search.searchedFor", { terms: searched.terms.join(", ") })}
        {searched.translatedFrom && <> {tm(locale, "search.fromQuery", { q: searched.translatedFrom })}</>}
      </p>
      {searched.notice === "translationFailed" && <p>{tm(locale, "search.translationFailed")}</p>}
    </div>
  );
}

/** Shown while a search is translated and run. */
export function SearchingStatus({ locale }: { locale: MonitorLocale }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
      {tm(locale, "search.searching")}
    </p>
  );
}
