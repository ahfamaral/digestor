import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { partyTimeline } from "@digestor/core";
import {
  getHistory, getMember, getPresence, getProfile, listMemberBills, listMemberSpeeches, listMemberVotes, searchSpeeches, speechFacets, type MemberRow,
} from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { BILL_PAGE } from "@/components/Monitor/AuthoredBills";
import { DeputyView } from "@/components/Monitor/DeputyView";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { requestLocale, translator } from "@/lib/monitor/server";
import { deputyHref, parseDeputy, type DeputyParams } from "@/lib/monitor/params";
import { MEMBER_PAGE, queryTerms, searchTerms } from "@/lib/monitor/search";
import { getServer } from "@/lib/server";

/** A deputy's workspace (official records only). `id` is the Câmara's deputy id. */
export default function DeputyPage({ params, searchParams }: PageProps<"/monitor/deputados/[id]">) {
  return (
    <>
      <AppBar />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
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
  if (!p.q) return <DeputyData locale={locale} member={member} params={p} />;
  // A search is translated first (up to 10 s): the header and the search form show at once, with "Searching…" meanwhile.
  const empty = { total: 0, rows: [] };
  const workspace = {
    profile: { profession: null, externalMandates: [], fronts: [], positions: [] }, bands: [], presence: null, bills: { total: 0, byType: [], rows: [] },
    phases: [], today: today(),
  };
  return (
    <Suspense
      key={deputyHref(member.externalId, p)}
      fallback={<DeputyView locale={locale} member={member} params={p} searched={null} speeches={empty} votes={empty} {...workspace} searching />}
    >
      <DeputyData locale={locale} member={member} params={p} />
    </Suspense>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

async function DeputyData({ locale, member, params: p }: { locale: MonitorLocale; member: MemberRow; params: DeputyParams }) {
  const { db } = getServer();
  const searched = p.q ? await searchTerms(p.q, translator()) : null;
  const terms = searched ? queryTerms(searched) : [];
  const paging = { limit: MEMBER_PAGE, offset: p.p * MEMBER_PAGE };
  const filters = { from: p.from ?? undefined, to: p.to ?? undefined, phase: p.phase ?? undefined };
  const speechesOf = () =>
    p.rel === "mentions"
      ? searchSpeeches(db, { terms, mentionOf: { memberId: member.id, name: member.name }, filters, sort: p.sort, ...paging })
      : searched
        ? searchSpeeches(db, { terms, memberId: member.id, filters, sort: p.sort, ...paging })
        : listMemberSpeeches(db, member.id, { ...paging, ...filters });
  const [speeches, votes, profile, history, presence, bills, facets] = await Promise.all([
    speechesOf(),
    listMemberVotes(db, member.id, { limit: 1000 }),
    getProfile(db, member.id),
    getHistory(db, member.id),
    getPresence(db, member.id, p.year),
    listMemberBills(db, member.id, { type: p.btype ?? undefined, limit: BILL_PAGE, offset: p.bp * BILL_PAGE }),
    speechFacets(db),
  ]);
  return (
    <DeputyView
      locale={locale} member={member} params={p} searched={searched} speeches={speeches} votes={votes} profile={profile}
      bands={partyTimeline(history)} presence={presence} bills={bills} phases={facets.phases} today={today()}
    />
  );
}
