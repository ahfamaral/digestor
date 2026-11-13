import Link from "next/link";
import type { TimelineBand } from "@digestor/core";
import type {
  DistinctiveWord, MemberBill, MemberRow, Presence as PresenceRecord, ProfileInput, SpeechHit, SpeechRow, VoteRow as Vote,
} from "@digestor/core/server";
import { BackLink } from "@/components/BackLink";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, directoryHref, MONITOR_YEARS, type DeputyParams } from "@/lib/monitor/params";
import { deputyUrl, MEMBER_PAGE, VOTE_PAGE, type Searched } from "@/lib/monitor/search";
import { AuthoredBills } from "./AuthoredBills";
import { DeputyCombobox } from "./DeputyCombobox";
import { DeputySearch } from "./DeputySearch";
import { ExternalLink } from "./ExternalLink";
import { Fronts } from "./Fronts";
import { LanguageSwitch } from "./LanguageSwitch";
import { Pager } from "./Pager";
import { PartyTimeline } from "./PartyTimeline";
import { Positions } from "./Positions";
import { Presence } from "./Presence";
import { ProfileLine } from "./ProfileLine";
import { ScrollToHash } from "./ScrollToHash";
import { SearchedFor, SearchingStatus } from "./SearchedFor";
import { SectionNav } from "./SectionNav";
import { Section } from "./Section";
import { SortSwitch } from "./SortSwitch";
import { SpeechItem } from "./SpeechItem";
import { TopicNote } from "./TopicNote";
import { VoteFilters, votesEmpty, votesFiltered, type Guided } from "./VoteFilters";
import { VoteRow } from "./VoteRow";
import { WordHeat } from "./WordHeat";
import { YearSelect } from "./YearSelect";

/** The speech search, its sort and its pages land here instead of the top of the page. */
const SPEECHES = "speeches";
/** The section links at the top (Words only once loaded, Fronts only when the deputy joined any). */
const NAV = ["speeches", "words", "bills", "votes", "presence", "fronts"] as const;

export type DeputyWorkspace = {
  profile: ProfileInput; bands: TimelineBand[]; presence: PresenceRecord | null;
  /** `all`: every bill the deputy signed (the filters aside); `years`: the years presented; `searched`: what `bq` searched. */
  bills: { total: number; all?: number; years?: number[]; byType: { type: string; n: number }[]; rows: MemberBill[]; searched?: Searched | null };
  phases: string[]; today: string;
  /** "Words used more than the chamber" (`distinctiveWords`); null while searching. */
  words: { enough: boolean; words: DistinctiveWord[] } | null;
};

/**
 * A deputy's workspace, all official records: header and profile, party timeline, positions, the speech search (their
 * speeches, or others' mentioning them), authored bills, recorded votes, presence and fronts. Speeches and votes are
 * never paired; "Words used more than the chamber" sits after the speeches. `searching`: the Suspense fallback while a query is translated and run (the records below the search hidden
 * meanwhile; header, timeline and positions stay).
 */
export function DeputyView({
  locale, member, params, searched, speeches, votes, profile, bands, presence, bills, phases, today, words, searching = false,
}: DeputyWorkspace & {
  locale: MonitorLocale; member: MemberRow; params: DeputyParams; searched: Searched | null; searching?: boolean;
  speeches: { total: number; rows: (SpeechRow | SpeechHit)[] };
  /** `total`: the votes the filters keep; `all`: every recorded vote of the deputy; `searched`: what `vq` searched. */
  votes: { total: number; all?: number; rows: Vote[]; searched?: Searched | null } & Guided;
}) {
  const id = member.externalId;
  const mentions = params.rel === "mentions";
  const filtered = !!(params.q || mentions || params.from || params.to || params.phase);
  const yearHrefs = Object.fromEntries(MONITOR_YEARS.map((y) => [y, deputyHref(id, { ...params, year: y, p: 0, bp: 0, vp: 0, vfrom: null, vto: null })]));
  const allVotes = votes.all ?? votes.total;
  return (
    <div lang={locale} className="grid gap-8">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <BackLink href="/monitor" label={tm(locale, "member.back")} />
          {/* Another deputy: the first thing on the page, above the header (owner, 2026-11-11). */}
          <div className="order-last flex w-full flex-col items-start gap-x-3 gap-y-1.5 sm:order-none sm:w-auto sm:max-w-md sm:flex-1 sm:flex-row sm:items-center">
            <div className="w-full min-w-0 sm:flex-1">
              <DeputyCombobox locale={locale} size="sm" label={tm(locale, "landing.findDeputy")} />
            </div>
            <Link
              href={directoryHref()}
              className="shrink-0 rounded text-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-stone-500"
            >
              {tm(locale, "directory.browseShort")}
            </Link>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <YearSelect locale={locale} year={params.year} hrefs={yearHrefs} />
            <LanguageSwitch locale={locale} back={deputyHref(id, params)} />
          </div>
        </div>
        <div className="flex items-start gap-4">
          {member.photoUrl && (
            // The Câmara's own photo URL, loaded by the browser (no next/image proxy).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={member.photoUrl} alt="" width={64} height={85} referrerPolicy="no-referrer" className="h-[85px] w-16 shrink-0 rounded-lg border border-border object-cover" />
          )}
          <div className="grid min-w-0 gap-0.5">
            <h1 className="text-xl font-bold tracking-tight break-words">{member.name}</h1>
            <p className="text-sm text-muted-foreground">
              {[member.party, member.uf].filter(Boolean).join("-")}
              {!member.inOffice && <> · {tm(locale, "member.notInOffice")}</>}
            </p>
            <ProfileLine locale={locale} profile={profile} />
            <ExternalLink href={deputyUrl(id)} className="w-fit text-sm">
              {tm(locale, "member.officialRecord")}
            </ExternalLink>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{tm(locale, "dataNote")}</p>
      </div>

      <SectionNav
        label={tm(locale, "nav.label")}
        links={NAV.filter((n) => (n !== "fronts" || profile.fronts.length > 0) && (n !== "words" || words !== null)).map((n) => ({ id: n, text: tm(locale, `nav.${n}`) }))}
      />

      {/* Shown while searching too: the page above the speech search keeps its height, so #speeches stays in view. */}
      <PartyTimeline locale={locale} bands={bands} today={today} />
      <Positions locale={locale} positions={profile.positions} today={today} />

      <section id={SPEECHES} tabIndex={-1} className="grid scroll-mt-14 gap-3 outline-none" aria-label={tm(locale, "sections.speeches")}>
        <DeputySearch locale={locale} externalId={id} params={params} phases={phases} />
        {searching && <SearchingStatus locale={locale} />}
        {searched && <SearchedFor locale={locale} searched={searched} />}
        {mentions && <TopicNote text={tm(locale, "deputySearch.mentionsOf", { name: member.name })} />}
        {!searching && (
          <>
            {(params.q || mentions) && (
              <SortSwitch locale={locale} sort={params.sort} href={(sort) => `${deputyHref(id, { ...params, sort, p: 0 })}#${SPEECHES}`} />
            )}
            <div className="grid">
              <Section
                title={tm(locale, mentions ? "deputySearch.mentions" : "sections.speeches")}
                count={speeches.total ? formatCount(speeches.total, locale) : undefined}
                empty={speeches.total ? null : tm(locale, filtered ? "empty.speeches" : "empty.memberSpeeches")}
              >
                {speeches.rows.map((s) => (
                  <SpeechItem key={s.id} locale={locale} speech={s} showMember={mentions} />
                ))}
              </Section>
              <Pager locale={locale} page={params.p} size={MEMBER_PAGE} total={speeches.total} href={(p) => `${deputyHref(id, { ...params, p })}#${SPEECHES}`} label={tm(locale, "paging.speeches")} />
            </div>
          </>
        )}
      </section>

      {!searching && (
        <>
          {words && <WordHeat locale={locale} result={words} year={params.year} />}
          <AuthoredBills locale={locale} externalId={id} params={params} bills={bills} />
          <div className="grid">
            <Section
              id="votes"
              title={tm(locale, "sections.votes")}
              count={allVotes ? formatCount(allVotes, locale) : undefined}
              note={tm(locale, "votes.note")}
              toolbar={
                allVotes > 0 && (
                  <VoteFilters
                    locale={locale} externalId={id} params={params} today={today} total={votes.total} all={allVotes} searched={votes.searched ?? null}
                    guidedAll={votes.guidedAll}
                  />
                )
              }
              empty={votes.total ? null : allVotes > 0 && votesFiltered(params) ? votesEmpty(locale, params, votes) : tm(locale, "empty.memberVotes")}
            >
              {votes.rows.map((v) => (
                <VoteRow key={v.rollCallId} locale={locale} vote={v} from={id} />
              ))}
            </Section>
            <Pager locale={locale} page={params.vp} size={VOTE_PAGE} total={votes.total} href={(vp) => `${deputyHref(id, { ...params, vp })}#votes`} label={tm(locale, "paging.votes")} />
          </div>
          <Presence locale={locale} presence={presence} year={params.year} />
          <Fronts locale={locale} fronts={profile.fronts} />
          <ScrollToHash />
        </>
      )}
    </div>
  );
}
