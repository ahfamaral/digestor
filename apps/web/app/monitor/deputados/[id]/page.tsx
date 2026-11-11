import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getMember, listMemberSpeeches, listMemberVotes, searchSpeeches, type MemberRow } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { DeputyView } from "@/components/Monitor/DeputyView";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { requestLocale, translator } from "@/lib/monitor/server";
import { backPath, cleanQuery, MEMBER_PAGE, pageParam, queryTerms, searchTerms, stringParam } from "@/lib/monitor/search";
import { getServer } from "@/lib/server";

/** A deputy's speeches (searchable, this deputy only) and recorded votes. `id` is the Câmara's deputy id. */
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
  const sp = await searchParams;
  const q = stringParam(sp.q);
  const page = pageParam(sp.p);
  const locale = await requestLocale();
  const back = backPath(`/monitor/deputados/${member.externalId}`, sp);
  if (!cleanQuery(q)) return <DeputyData locale={locale} member={member} q={q} page={page} back={back} />;
  // A search is translated first (up to 10 s): the header and box show at once, with "Searching…" meanwhile.
  const empty = { total: 0, rows: [] };
  return (
    <Suspense
      key={`${q}|${page}`}
      fallback={<DeputyView locale={locale} member={member} q={q} searched={null} speeches={empty} votes={empty} page={page} back={back} searching />}
    >
      <DeputyData locale={locale} member={member} q={q} page={page} back={back} />
    </Suspense>
  );
}

async function DeputyData({ locale, member, q, page, back }: { locale: MonitorLocale; member: MemberRow; q: string; page: number; back: string }) {
  const { db } = getServer();
  const clean = cleanQuery(q);
  const searched = clean ? await searchTerms(clean, translator()) : null;
  const paging = { limit: MEMBER_PAGE, offset: page * MEMBER_PAGE };
  const [speeches, votes] = await Promise.all([
    searched ? searchSpeeches(db, { terms: queryTerms(searched), memberId: member.id, ...paging }) : listMemberSpeeches(db, member.id, paging),
    listMemberVotes(db, member.id, { limit: 1000 }),
  ]);
  return <DeputyView locale={locale} member={member} q={q} searched={searched} speeches={speeches} votes={votes} page={page} back={back} />;
}
