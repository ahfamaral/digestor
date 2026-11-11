import Link from "next/link";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { SEARCH_PAGE, type SearchResult } from "@/lib/monitor/search";
import { LanguageSwitch } from "./LanguageSwitch";
import { Pager } from "./Pager";
import { RollCallItem } from "./RollCallItem";
import { SearchBox } from "./SearchBox";
import { SearchedFor, SearchingStatus } from "./SearchedFor";
import { Section } from "./Section";
import { SpeechItem } from "./SpeechItem";

/** `/monitor`: one search box, then Deputies (by name), Speeches and Roll calls (by the searched terms). */
/** `searching`: the Suspense fallback while the query is translated and run (header and box stay, a status line instead of results). */
export function SearchView({ locale, q, result, page, back, searching = false }: { locale: MonitorLocale; q: string; result: SearchResult | null; page: number; back: string; searching?: boolean }) {
  // A topic search rarely matches a name: the Deputies section shows only with matches, or when nothing matched at all.
  const nothingElse = !result?.speeches.total && !result?.rollCalls.length;
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
          {(result.members.length > 0 || nothingElse) && (
          <Section title={tm(locale, "sections.deputies")} empty={result.members.length ? null : tm(locale, "empty.deputies")}>
            {result.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-baseline gap-x-2 px-4 py-3 text-sm">
                <Link href={`/monitor/deputados/${m.externalId}`} className="font-semibold underline-offset-2 hover:underline">
                  {m.name}
                </Link>
                <span className="text-muted-foreground">{[m.party, m.uf].filter(Boolean).join("-")}</span>
                {!m.inOffice && <span className="text-xs text-muted-foreground">{tm(locale, "member.notInOffice")}</span>}
              </li>
            ))}
          </Section>
          )}
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
          <Section title={tm(locale, "sections.rollCalls")} empty={result.rollCalls.length ? null : tm(locale, "empty.rollCalls")}>
            {result.rollCalls.map((r) => (
              <RollCallItem key={r.id} locale={locale} rollCall={r} />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
