import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { partyTimeline, type TimelineBand } from "@digestor/core";
import {
  distinctiveWords, getHistory, getMember, getPresence, getProfile, listMemberBills, listMemberSpeeches, listMemberVotes, searchSpeeches, speechFacets, type MemberRow,
  type ProfileInput,
} from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { BILL_PAGE } from "@/components/Monitor/AuthoredBills";
import { DeputyView } from "@/components/Monitor/DeputyView";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { requestLocale, translator } from "@/lib/monitor/server";
import { deputyHref, parseDeputy, type DeputyParams } from "@/lib/monitor/params";
import { MEMBER_PAGE, queryTerms, searchTerms, typedPhrase, VOTE_PAGE } from "@/lib/monitor/search";
import { getServer } from "@/lib/server";
import { monitorTitle } from "@/lib/monitor/titles";
import type { Metadata } from "next";

/** The tab names the deputy. */
export async function generateMetadata({ params }: PageProps<"/monitor/deputados/[id]">): Promise<Metadata> {
  const { id } = await params;
  const member = /^[1-9]\d{0,8}$/.test(id) ? await getMember(getServer().db, "camara", Number(id)) : null;
  return { title: monitorTitle(await requestLocale(), member?.name) };
}

/** A deputy's workspace (official records only). `id` is the Câmara's deputy id. */
export default function DeputyPage({ params, searchParams }: PageProps<"/monitor/deputados/[id]">) {
  return (
    <>
      <AppBar area="monitor" skipTo="content" />
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none sm:px-6">
        <Suspense fallback={null}>
          <Deputy params={params} searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function Deputy({ params, searchParams }: Pick<PageProps<"/monitor/deputados/[id]">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  if (!/^[1-9]\d{0,8}$/.test(id)) notFound();
  const { db } = getServer();
  const member = await getMember(db, "camara", Number(id));
  if (!member) notFound();
  const p = parseDeputy(await searchParams);
  const locale = await requestLocale();
  // Profile and party history come first, so the page above the speech search (header, timeline, positions) is the same
  // while "Searching…" shows: a link to #speeches then lands on the search and stays there when the results arrive.
  const [profile, history] = await Promise.all([getProfile(db, member.id), getHistory(db, member.id)]);
  const record = { profile, bands: partyTimeline(history) };
  if (!p.q) return <DeputyData locale={locale} member={member} params={p} {...record} />;
  // A search is translated first (up to 10 s): the header and the search form show at once, with "Searching…" meanwhile.
  const empty = { total: 0, rows: [] };
  const workspace = { ...record, presence: null, bills: { total: 0, byType: [], rows: [] }, phases: [], today: today(), words: null };
  return (
    <Suspense
      key={deputyHref(member.externalId, p)}
      fallback={<DeputyView locale={locale} member={member} params={p} searched={null} speeches={empty} votes={empty} {...workspace} searching />}
    >
      <DeputyData locale={locale} member={member} params={p} {...record} />
    </Suspense>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

async function DeputyData({
  locale, member, params: p, profile, bands,
}: { locale: MonitorLocale; member: MemberRow; params: DeputyParams; profile: ProfileInput; bands: TimelineBand[] }) {
  const { db } = getServer();
  const searched = p.q ? await searchTerms(p.q, translator(), p.exact) : null;
  const terms = searched ? queryTerms(searched) : [];
  const phrase = searched ? typedPhrase(searched.q) : undefined;
  const paging = { limit: MEMBER_PAGE, offset: p.p * MEMBER_PAGE };
  const filters = { from: p.from ?? undefined, to: p.to ?? undefined, phase: p.phase ?? undefined };
  const speechesOf = () =>
    p.rel === "mentions"
      ? searchSpeeches(db, { terms, phrase, mentionOf: { memberId: member.id, name: member.name }, filters, sort: p.sort, ...paging })
      : searched
        ? searchSpeeches(db, { terms, phrase, memberId: member.id, filters, sort: p.sort, ...paging })
        : listMemberSpeeches(db, member.id, { ...paging, ...filters });
  const [speeches, votes, presence, bills, facets, words] = await Promise.all([
    speechesOf(),
    listMemberVotes(db, member.id, { limit: VOTE_PAGE, offset: p.vp * VOTE_PAGE }),
    getPresence(db, member.id, p.year),
    listMemberBills(db, member.id, { type: p.btype ?? undefined, limit: BILL_PAGE, offset: p.bp * BILL_PAGE }),
    speechFacets(db),
    distinctiveWords(db, { memberId: member.id }, { year: p.year }),
  ]);
  return (
    <DeputyView
      locale={locale} member={member} params={p} searched={searched} speeches={speeches} votes={votes} profile={profile}
      bands={bands} presence={presence} bills={bills} phases={facets.phases} today={today()} words={words}
    />
  );
}
