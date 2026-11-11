import { Search } from "lucide-react";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { landingHref, MONITOR_YEARS, type LandingParams } from "@/lib/monitor/params";
import { MAX_QUERY, SEARCH_PAGE, type LandingResult } from "@/lib/monitor/search";
import { DeputyCombobox } from "./DeputyCombobox";
import { LanguageSwitch } from "./LanguageSwitch";
import { Pager } from "./Pager";
import { RollCallItem } from "./RollCallItem";
import { SearchedFor, SearchingStatus } from "./SearchedFor";
import { Section } from "./Section";
import { SortSwitch } from "./SortSwitch";
import { SpeechItem } from "./SpeechItem";
import { TopicFilters, type Facets } from "./TopicFilters";
import { YearSelect } from "./YearSelect";

const card = "grid gap-3 rounded-xl border border-border bg-white p-4 sm:p-5";

/**
 * `/monitor`: two doors. Find a deputy (the combobox opens their page) or search a topic across the Câmara (a GET form
 * with filters); then the topic's speeches and roll calls, each with its own count and pages. `searching`: the
 * Suspense fallback while the query is translated and run.
 */
export function LandingView({
  locale, params, facets, result, searching = false,
}: { locale: MonitorLocale; params: LandingParams; facets: Facets; result: LandingResult | null; searching?: boolean }) {
  const yearHrefs = Object.fromEntries(MONITOR_YEARS.map((y) => [y, landingHref({ ...params, year: y, p: 0, rp: 0 })]));
  return (
    <div lang={locale} className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-xl font-bold tracking-tight">{tm(locale, "title")}</h1>
          <div className="flex items-center gap-3">
            <YearSelect locale={locale} year={params.year} hrefs={yearHrefs} />
            <LanguageSwitch locale={locale} back={landingHref(params)} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{tm(locale, "dataNote")}</p>
      </div>

      <section className={card} aria-labelledby="door-deputy">
        <div className="grid gap-0.5">
          <h2 id="door-deputy" className="text-base font-semibold">{tm(locale, "landing.findDeputy")}</h2>
          <p className="text-sm text-muted-foreground">{tm(locale, "landing.findDeputyHint")}</p>
        </div>
        <DeputyCombobox locale={locale} size="lg" label={tm(locale, "combobox.label")} />
      </section>

      <section className={card} aria-labelledby="door-topic">
        <h2 id="door-topic" className="text-base font-semibold">{tm(locale, "landing.topic")}</h2>
        <form role="search" action="/monitor" method="get" className="grid gap-4">
          <div className="flex gap-2">
            <label htmlFor="monitor-q" className="sr-only">{tm(locale, "landing.topicLabel")}</label>
            <input
              id="monitor-q"
              name="q"
              type="search"
              defaultValue={params.q}
              maxLength={MAX_QUERY}
              placeholder={tm(locale, "landing.topicPlaceholder")}
              className="h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
            />
            <button
              type="submit"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Search className="size-4" aria-hidden />
              {tm(locale, "search.button")}
            </button>
          </div>
          {params.sort === "new" && <input type="hidden" name="sort" value="new" />}
          <TopicFilters locale={locale} params={params} facets={facets} />
        </form>
      </section>

      {(searching || result?.q) && (
        <div className="grid gap-2">
          {searching && <SearchingStatus locale={locale} />}
          {result && <SearchedFor locale={locale} searched={result} />}
          {result?.q && <SortSwitch locale={locale} sort={params.sort} href={(sort) => landingHref({ ...params, sort, p: 0, rp: 0 })} />}
        </div>
      )}

      {result?.q && result.speeches && (
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
          <Pager locale={locale} page={params.p} size={SEARCH_PAGE} total={result.speeches.total} href={(p) => landingHref({ ...params, p })} />
        </div>
      )}
      {result?.q && result.rollCalls && (
        <div className="grid">
          <Section
            title={tm(locale, "sections.rollCalls")}
            count={result.rollCalls.total ? formatCount(result.rollCalls.total, locale) : undefined}
            empty={result.rollCalls.total ? null : tm(locale, "empty.rollCalls")}
          >
            {result.rollCalls.rows.map((r) => (
              <RollCallItem key={r.id} locale={locale} rollCall={r} />
            ))}
          </Section>
          <Pager locale={locale} page={params.rp} size={SEARCH_PAGE} total={result.rollCalls.total} href={(rp) => landingHref({ ...params, rp })} />
        </div>
      )}
    </div>
  );
}
