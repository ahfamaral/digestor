import Link from "next/link";
import { Search } from "lucide-react";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { directoryHref, landingHref, MONITOR_YEARS, type LandingParams } from "@/lib/monitor/params";
import { MAX_QUERY, SEARCH_PAGE, type LandingResult } from "@/lib/monitor/search";
import { AskForm } from "./AskRecordView";
import { DeputyCombobox } from "./DeputyCombobox";
import { ExactBox } from "./ExactBox";
import { Spinner } from "@/components/ui/spinner";
import { GetForm } from "./GetForm";
import { JumpLink } from "./JumpLink";
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
 * `/monitor`: three doors. Find a deputy (the combobox opens their page), search a topic across the Câmara (a GET form
 * with filters), or ask the record (a question answered with quoted passages, `/monitor/perguntar`; hidden while topic
 * results show, so they stay right under their form); then the topic's speeches and roll calls, each with its own
 * count and pages. `searching`: the
 * Suspense fallback while the query is translated and run. `askedEmpty`: the form was sent without a topic. `deputies`:
 * how many are in office, for the link to the directory.
 */
export function LandingView({
  locale, params, facets, result, searching = false, askedEmpty = false, deputies,
}: {
  locale: MonitorLocale; params: LandingParams; facets: Facets; result: LandingResult | null; searching?: boolean; askedEmpty?: boolean;
  deputies?: number;
}) {
  const speechOnlyFilters = !!(params.party || params.uf || params.phase || params.inOffice);
  // rows only the search by meaning found are listed among the speeches but never counted as matches
  const meaningOnly = result?.speeches?.meaningOnly ?? 0;
  const speechWords = (result?.speeches?.total ?? 0) - meaningOnly;
  const speechNote = result?.meaning === "used" && meaningOnly > 0
    ? tm(locale, speechWords === 0 ? "search.meaningNoWords" : "search.meaningUsed")
    : undefined;
  const counts = result?.q
    ? [
        result.speeches && { id: "speeches", n: speechWords, one: "landing.speechesOne", many: "landing.speeches", meaningOnly },
        result.rollCalls && { id: "rollcalls", n: result.rollCalls.total, one: "landing.rollCallsOne", many: "landing.rollCalls", meaningOnly: 0 },
      ].filter((c) => !!c)
    : [];
  const plusMeaning = meaningOnly > 0 ? ` · ${tm(locale, "search.meaningCount", { n: formatCount(meaningOnly, locale) })}` : "";
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
        <Link
          href={directoryHref()}
          className="w-fit rounded text-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
        >
          {deputies ? tm(locale, "directory.browse", { n: formatCount(deputies, locale) }) : tm(locale, "directory.browseShort")}
        </Link>
      </section>

      <section className={card} aria-labelledby="door-topic">
        <h2 id="door-topic" className="text-base font-semibold">{tm(locale, "landing.topic")}</h2>
        <GetForm action="/monitor" className="grid gap-4" required={{ name: "q", hint: tm(locale, "landing.noTopic") }}>
          <div className="flex gap-2">
            <label htmlFor="monitor-q" className="sr-only">{tm(locale, "landing.topicLabel")}</label>
            <input
              id="monitor-q"
              name="q"
              type="search"
              defaultValue={params.q}
              maxLength={MAX_QUERY}
              placeholder={tm(locale, "landing.topicPlaceholder")}
              className="h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-stone-500 focus-visible:ring-3 focus-visible:ring-stone-500 md:text-sm"
            />
            <button
              type="submit"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground outline-none hover:brightness-90 focus-visible:ring-3 focus-visible:ring-stone-500"
            >
              <Search className="size-4 group-aria-busy/get:hidden" aria-hidden />
              <Spinner className="size-4 hidden group-aria-busy/get:block" />
              {tm(locale, "search.button")}
            </button>
          </div>
          {askedEmpty && <p role="status" className="-mt-2 text-sm text-muted-foreground">{tm(locale, "landing.noTopic")}</p>}
          <ExactBox locale={locale} checked={params.exact} />
          {params.sort === "new" && <input type="hidden" name="sort" value="new" />}
          <TopicFilters locale={locale} params={params} facets={facets} />
        </GetForm>
      </section>

      {!searching && !result?.q && (
        <section className={card} aria-labelledby="door-ask">
          <div className="grid gap-0.5">
            <h2 id="door-ask" className="text-base font-semibold">{tm(locale, "ask.door")}</h2>
            <p className="text-sm text-muted-foreground">{tm(locale, "ask.doorHint")}</p>
          </div>
          <AskForm locale={locale} params={{ q: "", from: null, to: null }} id="door-ask-q" />
          <p className="text-xs text-muted-foreground">{tm(locale, "ask.fixedLine")}</p>
        </section>
      )}

      {(searching || result?.q) && (
        <div className="grid gap-2">
          {searching && <SearchingStatus locale={locale} />}
          {result && <SearchedFor locale={locale} searched={result} />}
          {result?.meaning === "unavailable" && <p className="text-sm text-muted-foreground">{tm(locale, "search.meaningUnavailable")}</p>}
          {counts.length > 0 && (
            <nav aria-label={tm(locale, "landing.resultsLabel")} className="flex flex-wrap items-center gap-x-2 text-sm">
              {counts.map((c, i) => (
                <span key={c.id} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden className="text-muted-foreground">·</span>}
                  <JumpLink id={c.id} className="rounded font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-stone-500">
                    {`${c.n === 1 ? tm(locale, c.one as "landing.speechesOne") : tm(locale, c.many as "landing.speeches", { n: formatCount(c.n, locale) })}${c.meaningOnly > 0 ? plusMeaning : ""}`}
                  </JumpLink>
                </span>
              ))}
            </nav>
          )}
          {result?.q && <SortSwitch locale={locale} sort={params.sort} href={(sort) => landingHref({ ...params, sort, p: 0, rp: 0 })} />}
        </div>
      )}

      {result?.q && result.speeches && (
        <div className="grid">
          <Section
            id="speeches"
            title={tm(locale, "sections.speeches")}
            count={result.speeches.total ? `${formatCount(speechWords, locale)}${plusMeaning}` : undefined}
            note={speechNote}
            empty={result.speeches.total ? null : tm(locale, "empty.speeches")}
          >
            {result.speeches.rows.map((s) => (
              <SpeechItem key={s.id} locale={locale} speech={s} showMember />
            ))}
          </Section>
          <Pager locale={locale} page={params.p} size={SEARCH_PAGE} total={result.speeches.total} href={(p) => landingHref({ ...params, p })} label={tm(locale, "paging.speeches")} />
        </div>
      )}
      {result?.q && result.rollCalls && (
        <div className="grid">
          <Section
            id="rollcalls"
            title={tm(locale, "sections.rollCalls")}
            count={result.rollCalls.total ? formatCount(result.rollCalls.total, locale) : undefined}
            note={speechOnlyFilters ? tm(locale, "filters.speechesOnlyNote") : undefined}
            empty={result.rollCalls.total ? null : tm(locale, "empty.rollCalls")}
          >
            {result.rollCalls.rows.map((r) => (
              <RollCallItem key={r.id} locale={locale} rollCall={r} back={landingHref(params)} />
            ))}
          </Section>
          <Pager locale={locale} page={params.rp} size={SEARCH_PAGE} total={result.rollCalls.total} href={(rp) => landingHref({ ...params, rp })} label={tm(locale, "paging.rollCalls")} />
        </div>
      )}
    </div>
  );
}
