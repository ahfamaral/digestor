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
import { VOTE_FILTERS } from "@digestor/core";
import {
  billMeaning, hybridBills, hybridVotes, MEMBER_PAGE, queryTerms, searchTerms, typedPhrase, voteMeaning, VOTE_PAGE, type RecordSemantic,
} from "@/lib/monitor/search";
import { recordSearch } from "@/lib/monitor/semantic";
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
  // A search (speeches, votes or bills) is translated first (up to 10 s): on a first load the header and the search
  // forms show at once, with "Searching…" meanwhile. Always the same boundary, keyed on the speech search only: filtering
  // or paging the votes or bills in place keeps the page on screen while it loads.
  const empty = { total: 0, rows: [] };
  const workspace = { ...record, presence: null, bills: { total: 0, byType: [], rows: [] }, phases: [], today: today(), words: null };
  const searching = p.q || p.vq || p.bq
    ? <DeputyView locale={locale} member={member} params={p} searched={null} speeches={empty} votes={empty} {...workspace} searching />
    : null;
  return (
    <Suspense
      key={deputyHref(member.externalId, { q: p.q, exact: p.exact, rel: p.rel, from: p.from, to: p.to, phase: p.phase, sort: p.sort, year: p.year, p: p.p })}
      fallback={searching}
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
  const translate = translator();
  const semantic: RecordSemantic = (kind, q, ids) => recordSearch(kind, q, ids);
  const voteFilters = {
    vote: p.vv ? VOTE_FILTERS[p.vv] : undefined, kind: p.vk ?? undefined, from: p.vfrom ?? undefined, to: p.vto ?? undefined,
    differsFromGuidance: p.vdiff || undefined,
  };
  // The three text boxes (speeches, votes, bills) are translated side by side, each with its own "exact" box. The vote
  // and bill boxes are also searched by meaning (the typed words, any language) in parallel, unless "exact" is ticked.
  const [searched, votesSearched, billsSearched, votesMeaning, billsMeaning] = await Promise.all([
    p.q ? searchTerms(p.q, translate, p.exact) : null,
    p.vq ? searchTerms(p.vq, translate, p.vexact) : null,
    p.bq ? searchTerms(p.bq, translate, p.bexact) : null,
    p.vq && !p.vexact ? voteMeaning(db, member.id, voteFilters, p.vq, semantic) : null,
    p.bq && !p.bexact ? billMeaning(db, member.id, { year: p.byear ?? undefined }, p.bq, semantic) : null,
  ]);
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
  const votePage = { limit: VOTE_PAGE, offset: p.vp * VOTE_PAGE };
  const votesOf = async () =>
    votesSearched && votesMeaning
      ? hybridVotes(db, member.id, { terms: queryTerms(votesSearched), phrase: typedPhrase(votesSearched.q), filters: voteFilters, meaning: votesMeaning, ...votePage })
      : { ...(await listMemberVotes(db, member.id, { ...votePage, ...voteFilters, q: votesSearched ? queryTerms(votesSearched) : undefined })), meaning: "off" as const };
  const billPage = { limit: BILL_PAGE, offset: p.bp * BILL_PAGE };
  const billsOf = async () =>
    billsSearched && billsMeaning
      ? hybridBills(db, member.id, {
          terms: queryTerms(billsSearched), phrase: typedPhrase(billsSearched.q), type: p.btype ?? undefined, year: p.byear ?? undefined, meaning: billsMeaning,
          ...billPage,
        })
      : {
          ...(await listMemberBills(db, member.id, {
            type: p.btype ?? undefined, q: billsSearched ? queryTerms(billsSearched) : undefined, year: p.byear ?? undefined, ...billPage,
          })),
          meaning: "off" as const,
        };
  const [speeches, votes, presence, bills, facets, words] = await Promise.all([
    speechesOf(),
    votesOf(),
    getPresence(db, member.id, p.year),
    billsOf(),
    speechFacets(db),
    distinctiveWords(db, { memberId: member.id }, { year: p.year }),
  ]);
  return (
    <DeputyView
      locale={locale} member={member} params={p} searched={searched} speeches={speeches} votes={{ ...votes, searched: votesSearched }}
      profile={profile} bands={bands} presence={presence} bills={{ ...bills, searched: billsSearched }} phases={facets.phases} today={today()} words={words}
    />
  );
}
