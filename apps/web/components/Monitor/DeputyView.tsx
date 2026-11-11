import type { MemberRow, SpeechHit, SpeechRow, VoteRow as Vote } from "@digestor/core/server";
import { BackLink } from "@/components/BackLink";
import { formatCount, tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { deputyUrl, MEMBER_PAGE, type Searched } from "@/lib/monitor/search";
import { ExternalLink } from "./ExternalLink";
import { Pager } from "./Pager";
import { SearchBox } from "./SearchBox";
import { SearchedFor } from "./SearchedFor";
import { Section } from "./Section";
import { SpeechItem } from "./SpeechItem";
import { VoteRow } from "./VoteRow";

/**
 * A deputy's page: header, a search over this deputy's speeches only, the speeches (or the matches), and the recorded
 * votes in their own unfiltered list. Speeches and votes are never paired.
 */
export function DeputyView({
  locale, member, q, searched, speeches, votes, page,
}: {
  locale: MonitorLocale; member: MemberRow; q: string; searched: Searched | null;
  speeches: { total: number; rows: (SpeechRow | SpeechHit)[] }; votes: { total: number; rows: Vote[] }; page: number;
}) {
  const base = `/monitor/deputados/${member.externalId}`;
  const searching = !!searched?.q;
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <BackLink href="/monitor" label={tm(locale, "member.back")} />
        <div className="flex items-center gap-4">
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
            <ExternalLink href={deputyUrl(member.externalId)} className="w-fit text-sm">
              {tm(locale, "member.officialRecord")}
            </ExternalLink>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{tm(locale, "dataNote")}</p>
      </div>
      <div className="grid gap-2">
        <SearchBox action={base} q={q} label={tm(locale, "search.deputyLabel")} placeholder={tm(locale, "search.deputyPlaceholder")} button={tm(locale, "search.button")} />
        {searched && <SearchedFor locale={locale} searched={searched} />}
      </div>
      <div className="grid">
        <Section
          title={tm(locale, "sections.speeches")}
          count={speeches.total ? formatCount(speeches.total, locale) : undefined}
          empty={speeches.total ? null : tm(locale, searching ? "empty.speeches" : "empty.memberSpeeches")}
        >
          {speeches.rows.map((s) => (
            <SpeechItem key={s.id} locale={locale} speech={s} />
          ))}
        </Section>
        <Pager locale={locale} base={base} q={searching ? q : ""} page={page} size={MEMBER_PAGE} total={speeches.total} />
      </div>
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
    </div>
  );
}
