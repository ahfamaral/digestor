import { Suspense } from "react";
import { connection } from "next/server";
import { AppBar } from "@/components/AppBar";
import { SearchView } from "@/components/Monitor/SearchView";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { requestLocale, translator } from "@/lib/monitor/server";
import { backPath, pageParam, runSearch, stringParam } from "@/lib/monitor/search";
import { getServer } from "@/lib/server";

/** The Câmara monitor: search deputies, speeches and roll calls. Reads the DB per request (inside Suspense). */
export default function MonitorPage({ searchParams }: PageProps<"/monitor">) {
  return (
    <>
      <AppBar />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
        <Suspense fallback={null}>
          <MonitorSearch searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function MonitorSearch({ searchParams }: { searchParams: PageProps<"/monitor">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const q = stringParam(sp.q);
  const page = pageParam(sp.p);
  const locale = await requestLocale();
  const back = backPath("/monitor", sp);
  if (!q.trim()) return <SearchView locale={locale} q={q} result={null} page={page} back={back} />;
  // The query is translated first (up to 10 s): the header and box show at once, with "Searching…" until results arrive.
  return (
    <Suspense key={`${q}|${page}`} fallback={<SearchView locale={locale} q={q} result={null} page={page} back={back} searching />}>
      <MonitorResults locale={locale} q={q} page={page} back={back} />
    </Suspense>
  );
}

async function MonitorResults({ locale, q, page, back }: { locale: MonitorLocale; q: string; page: number; back: string }) {
  const result = await runSearch(getServer().db, q, translator(), { page });
  return <SearchView locale={locale} q={q} result={result} page={page} back={back} />;
}
