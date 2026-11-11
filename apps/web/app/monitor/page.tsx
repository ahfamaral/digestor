import { Suspense } from "react";
import { connection } from "next/server";
import { speechFacets } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { LandingView } from "@/components/Monitor/LandingView";
import type { Facets } from "@/components/Monitor/TopicFilters";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { landingHref, parseLanding, type LandingParams } from "@/lib/monitor/params";
import { requestLocale, translator } from "@/lib/monitor/server";
import { runSearch } from "@/lib/monitor/search";
import { getServer } from "@/lib/server";

/** The Câmara monitor: find a deputy, or search a topic with filters. Reads the DB per request (inside Suspense). */
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
  const params = parseLanding(await searchParams);
  const [locale, facets] = await Promise.all([requestLocale(), speechFacets(getServer().db)]);
  if (!params.q) return <LandingView locale={locale} params={params} facets={facets} result={null} />;
  // The query is translated first (up to 10 s): the header and both doors show at once, with "Searching…" meanwhile.
  return (
    <Suspense key={landingHref(params)} fallback={<LandingView locale={locale} params={params} facets={facets} result={null} searching />}>
      <MonitorResults locale={locale} params={params} facets={facets} />
    </Suspense>
  );
}

async function MonitorResults({ locale, params, facets }: { locale: MonitorLocale; params: LandingParams; facets: Facets }) {
  const result = await runSearch(getServer().db, params, translator());
  return <LandingView locale={locale} params={params} facets={facets} result={result} />;
}
