import { Suspense } from "react";
import { connection } from "next/server";
import { AppBar } from "@/components/AppBar";
import { SearchView } from "@/components/Monitor/SearchView";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { requestLocale, translator } from "@/lib/monitor/server";
import { landingHref, parseLanding, type LandingParams } from "@/lib/monitor/params";
import { runSearch } from "@/lib/monitor/search";
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
  const params = parseLanding(sp);
  const { q, p: page } = params;
  const locale = await requestLocale();
  const back = landingHref(params);
  if (!q.trim()) return <SearchView locale={locale} q={q} result={null} page={page} back={back} />;
  // The query is translated first (up to 10 s): the header and box show at once, with "Searching…" until results arrive.
  return (
    <Suspense key={`${q}|${page}`} fallback={<SearchView locale={locale} q={q} result={null} page={page} back={back} searching />}>
      <MonitorResults locale={locale} params={params} back={back} />
    </Suspense>
  );
}

async function MonitorResults({ locale, params, back }: { locale: MonitorLocale; params: LandingParams; back: string }) {
  const result = await runSearch(getServer().db, params, translator());
  return <SearchView locale={locale} q={params.q} result={result} page={params.p} back={back} />;
}
