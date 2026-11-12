import { Loader2 } from "lucide-react";
import type { Searched } from "@/lib/monitor/search";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";

/**
 * What was actually searched: the typed words (or their translation, with the query it came from), the related terms
 * the translator added (labelled as added automatically), or the exact words; a notice when translation failed.
 */
export function SearchedFor({ locale, searched }: { locale: MonitorLocale; searched: Searched }) {
  if (!searched.q) return null;
  const [first, ...related] = searched.terms;
  return (
    <div role="status" className="grid gap-1 text-sm text-muted-foreground">
      {searched.exact ? (
        <p>{tm(locale, "search.exactFor", { q: searched.q })}</p>
      ) : (
        <p>
          {tm(locale, "search.searchedFor", { terms: first ?? searched.q })}
          {searched.translatedFrom && <> {tm(locale, "search.fromQuery", { q: searched.translatedFrom })}</>}
          {related.length > 0 && <>; {tm(locale, "search.related", { terms: related.join(", ") })}</>}
        </p>
      )}
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
