import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { SEARCH_PAGE, type LandingResult } from "@/lib/monitor/search";
import { LanguageSwitch } from "./LanguageSwitch";
import { Pager } from "./Pager";
import { RollCallItem } from "./RollCallItem";
import { SearchBox } from "./SearchBox";
import { SearchedFor, SearchingStatus } from "./SearchedFor";
import { Section } from "./Section";
import { SpeechItem } from "./SpeechItem";

/** `/monitor`: one search box, then Deputies (by name), Speeches and Roll calls (by the searched terms). */
/** `searching`: the Suspense fallback while the query is translated and run (header and box stay, a status line instead of results). */
export function SearchView({ locale, q, result, page, back, searching = false }: { locale: MonitorLocale; q: string; result: LandingResult | null; page: number; back: string; searching?: boolean }) {
  return (
    <div lang={locale} className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-xl font-bold tracking-tight">{tm(locale, "title")}</h1>
          <LanguageSwitch locale={locale} back={back} />
        </div>
        <p className="text-sm text-muted-foreground">{tm(locale, "dataNote")}</p>
      </div>
      <div className="grid gap-2">
        <SearchBox action="/monitor" q={q} label={tm(locale, "search.label")} placeholder={tm(locale, "search.placeholder")} button={tm(locale, "search.button")} />
        {searching && <SearchingStatus locale={locale} />}
        {result && <SearchedFor locale={locale} searched={result} />}
      </div>
      {result?.q && (
        <>
          {result.speeches && (
          <div className="grid">
            <Section
              title={tm(locale, "sections.speeches")}
              count={result.speeches.total ? formatCount(result.speeches.total, locale) : undefined}
              empty={result.speeches.total ? null : tm(locale, "empty.speeches")}
            >
              {result.speeches.rows.map((s) => (
                <SpeechItem key={s.id} locale={locale} speech={s} showMember />
              ))}
            </Section>
            <Pager locale={locale} base="/monitor" q={result.q} page={page} size={SEARCH_PAGE} total={result.speeches.total} />
          </div>
          )}
          {result.rollCalls && (
          <Section title={tm(locale, "sections.rollCalls")} empty={result.rollCalls.total ? null : tm(locale, "empty.rollCalls")}>
            {result.rollCalls.rows.map((r) => (
              <RollCallItem key={r.id} locale={locale} rollCall={r} />
            ))}
          </Section>
          )}
        </>
      )}
    </div>
  );
}
