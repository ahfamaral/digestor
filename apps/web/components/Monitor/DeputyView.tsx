import type { TimelineBand } from "@digestor/core";
import type { MemberBill, MemberRow, Presence as PresenceRecord, ProfileInput, SpeechHit, SpeechRow, VoteRow as Vote } from "@digestor/core/server";
import { BackLink } from "@/components/BackLink";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyHref, MONITOR_YEARS, type DeputyParams } from "@/lib/monitor/params";
import { deputyUrl, MEMBER_PAGE, type Searched } from "@/lib/monitor/search";
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
import { SearchedFor, SearchingStatus } from "./SearchedFor";
import { Section } from "./Section";
import { SortSwitch } from "./SortSwitch";
import { SpeechItem } from "./SpeechItem";
import { TopicNote } from "./TopicNote";
import { VoteRow } from "./VoteRow";
import { YearSelect } from "./YearSelect";

export type DeputyWorkspace = {
  profile: ProfileInput; bands: TimelineBand[]; presence: PresenceRecord | null;
  bills: { total: number; byType: { type: string; n: number }[]; rows: MemberBill[] }; phases: string[]; today: string;
};

/**
 * A deputy's workspace, all official records: header and profile, party timeline, positions, the speech search (their
 * speeches, or others' mentioning them), authored bills, recorded votes, presence and fronts. Speeches and votes are
 * never paired. `searching`: the Suspense fallback while a query is translated and run (records hidden meanwhile).
 */
export function DeputyView({
  locale, member, params, searched, speeches, votes, profile, bands, presence, bills, phases, today, searching = false,
}: DeputyWorkspace & {
  locale: MonitorLocale; member: MemberRow; params: DeputyParams; searched: Searched | null; searching?: boolean;
  speeches: { total: number; rows: (SpeechRow | SpeechHit)[] }; votes: { total: number; rows: Vote[] };
}) {
  const id = member.externalId;
  const mentions = params.rel === "mentions";
  const filtered = !!(params.q || mentions || params.from || params.to || params.phase);
  const yearHrefs = Object.fromEntries(MONITOR_YEARS.map((y) => [y, deputyHref(id, { ...params, year: y, p: 0, bp: 0 })]));
  return (
    <div lang={locale} className="grid gap-8">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <BackLink href="/monitor" label={tm(locale, "member.back")} />
          <div className="flex items-center gap-3">
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
        <div className="grid gap-1 sm:max-w-sm">
          <DeputyCombobox locale={locale} size="sm" label={tm(locale, "landing.findDeputy")} />
        </div>
        <p className="text-xs text-muted-foreground">{tm(locale, "dataNote")}</p>
      </div>

      {!searching && <PartyTimeline locale={locale} bands={bands} today={today} />}
      {!searching && <Positions locale={locale} positions={profile.positions} today={today} />}

      <section className="grid gap-3" aria-labelledby="speeches-title">
        <h2 id="speeches-title" className="sr-only">{tm(locale, "sections.speeches")}</h2>
        <DeputySearch locale={locale} externalId={id} params={params} phases={phases} />
        {searching && <SearchingStatus locale={locale} />}
        {searched && <SearchedFor locale={locale} searched={searched} />}
        {mentions && <TopicNote text={tm(locale, "deputySearch.mentionsOf", { name: member.name })} />}
        {!searching && (
          <>
            {(params.q || mentions) && (
              <SortSwitch locale={locale} sort={params.sort} href={(sort) => deputyHref(id, { ...params, sort, p: 0 })} />
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
              <Pager locale={locale} page={params.p} size={MEMBER_PAGE} total={speeches.total} href={(p) => deputyHref(id, { ...params, p })} />
            </div>
          </>
        )}
      </section>

      {!searching && (
        <>
          <AuthoredBills locale={locale} externalId={id} params={params} bills={bills} />
          <Section
            title={tm(locale, "sections.votes")}
            count={votes.total ? formatCount(votes.total, locale) : undefined}
            note={tm(locale, "votes.note")}
            empty={votes.total ? null : tm(locale, "empty.memberVotes")}
          >
            {votes.rows.map((v) => (
              <VoteRow key={v.rollCallId} locale={locale} vote={v} />
            ))}
          </Section>
          <Presence locale={locale} presence={presence} year={params.year} />
          <Fronts locale={locale} fronts={profile.fronts} />
        </>
      )}
    </div>
  );
}
