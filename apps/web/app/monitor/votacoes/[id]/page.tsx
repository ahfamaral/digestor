import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getMember, getRollCall, getRollCallTitle } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { RollCallView } from "@/components/Monitor/RollCallView";
import { backToSearch, deputyHref, fromDeputy, isRollCallId } from "@/lib/monitor/params";
import { requestLocale } from "@/lib/monitor/server";
import { getServer } from "@/lib/server";
import { tm } from "@/lib/monitor/i18n";
import { monitorTitle } from "@/lib/monitor/titles";
import type { Metadata } from "next";

/** The tab names the bill voted ("PLP 80/2026 roll call"). */
export async function generateMetadata({ params }: PageProps<"/monitor/votacoes/[id]">): Promise<Metadata> {
  const { id } = await params;
  const locale = await requestLocale();
  const r = isRollCallId(id) ? await getRollCallTitle(getServer().db, id) : null;
  return { title: monitorTitle(locale, r?.billLabel ? tm(locale, "votes.pageTitle", { bill: r.billLabel }) : tm(locale, "votes.pageTitleNoBill")) };
}

/** A plenary roll call: votes by party at the time of the vote and the guidance. `id` is the Câmara's votação id. */
export default function RollCallPage({ params, searchParams }: PageProps<"/monitor/votacoes/[id]">) {
  return (
    <>
      <AppBar area="monitor" skipTo="content" />
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none sm:px-6">
        <Suspense fallback={null}>
          <RollCall params={params} searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function RollCall({ params, searchParams }: Pick<PageProps<"/monitor/votacoes/[id]">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  if (!isRollCallId(id)) notFound();
  const { db } = getServer();
  const sp = await searchParams;
  const from = fromDeputy(sp);
  const search = backToSearch(sp) ?? undefined;
  const locale = await requestLocale();
  const [rollCall, deputy] = await Promise.all([getRollCall(db, id), from ? getMember(db, "camara", from) : null]);
  if (!rollCall) notFound();
  // Opened from a deputy's page: the back link names them and returns to their votes (an unknown `from` is ignored);
  // found by a search: it returns to that search.
  const back = deputy
    ? { href: `${deputyHref(deputy.externalId)}#votes`, label: deputy.name }
    : search ? { href: search, label: tm(locale, "member.back") } : undefined;
  return <RollCallView locale={locale} rollCall={rollCall} back={back} from={deputy?.externalId} search={search} />;
}
