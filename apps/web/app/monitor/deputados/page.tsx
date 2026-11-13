import { Suspense } from "react";
import { connection } from "next/server";
import { distinctiveWords, listMembers } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { DirectoryView } from "@/components/Monitor/DirectoryView";
import { WordHeat, WordHeatLoading } from "@/components/Monitor/WordHeat";
import { tm, type MonitorLocale } from "@/lib/monitor/i18n";
import { MONITOR_YEARS, parseDirectory } from "@/lib/monitor/params";
import { requestLocale } from "@/lib/monitor/server";
import { monitorTitle } from "@/lib/monitor/titles";
import { getServer } from "@/lib/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return { title: monitorTitle(locale, tm(locale, "directory.title")) };
}

/** Every deputy, browsable without typing a name. Reads the DB per request (inside Suspense). */
export default function DirectoryPage({ searchParams }: PageProps<"/monitor/deputados">) {
  return (
    <>
      <AppBar area="monitor" skipTo="content" />
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none sm:px-6">
        <Suspense fallback={null}>
          <Directory searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function Directory({ searchParams }: Pick<PageProps<"/monitor/deputados">, "searchParams">) {
  await connection();
  const [params, locale, members] = await Promise.all([
    searchParams.then(parseDirectory), requestLocale(), listMembers(getServer().db, "camara"),
  ]);
  const words = params.party ? (
    <Suspense fallback={<WordHeatLoading locale={locale} />}>
      <PartyWords locale={locale} party={params.party} />
    </Suspense>
  ) : undefined;
  return <DirectoryView locale={locale} params={params} members={members} words={words} />;
}

/** The party's words by the party on the day of each speech; streamed, as a big party's labels take about a second. */
async function PartyWords({ locale, party }: { locale: MonitorLocale; party: string }) {
  const year = Math.max(...MONITOR_YEARS);
  const result = await distinctiveWords(getServer().db, { party }, { year });
  return <WordHeat locale={locale} result={result} year={year} party={party} />;
}
