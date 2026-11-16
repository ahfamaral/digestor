import { Suspense } from "react";
import { connection } from "next/server";
import { countInOffice, speechFacets } from "@digestor/core/server";
import { MonitorAppBar } from "@/components/Monitor/MonitorAppBar";
import { LandingView } from "@/components/Monitor/LandingView";
import type { Facets } from "@/components/Monitor/TopicFilters";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { landingHref, parseLanding, type LandingParams } from "@/lib/monitor/params";
import { requestLocale, translator } from "@/lib/monitor/server";
import { runSearch } from "@/lib/monitor/search";
import { semanticSearch } from "@/lib/monitor/semantic";
import { monitorTitle } from "@/lib/monitor/titles";
import type { Metadata } from "next";
import { getServer } from "@/lib/server";

/** The tab names the searched topic, so tabs and history entries can be told apart. */
export async function generateMetadata({ searchParams }: PageProps<"/monitor">): Promise<Metadata> {
  const params = parseLanding(await searchParams);
  return { title: monitorTitle(await requestLocale(), params.q) };
}

/** The Câmara monitor: find a deputy, or search a topic with filters. Reads the DB per request (inside Suspense). */
export default function MonitorPage({ searchParams }: PageProps<"/monitor">) {
  return (
    <>
      <MonitorAppBar />
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none sm:px-6">
        <Suspense fallback={null}>
          <MonitorSearch searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function MonitorSearch({ searchParams }: { searchParams: PageProps<"/monitor">["searchParams"] }) {
  await connection();
  const raw = await searchParams;
  const params = parseLanding(raw);
  const { db } = getServer();
  const [locale, facets, deputies] = await Promise.all([requestLocale(), speechFacets(db), countInOffice(db, "camara")]);
  const view = { locale, params, facets, deputies };
  // The topic form sent without a topic (only filters, or blanks): say what to type.
  if (!params.q) return <LandingView {...view} result={null} askedEmpty={"q" in raw} />;
  // The query is translated first (up to 10 s): the header and both doors show at once, with "Searching…" meanwhile.
  return (
    <Suspense key={landingHref(params)} fallback={<LandingView {...view} result={null} searching />}>
      <MonitorResults {...view} />
    </Suspense>
  );
}

async function MonitorResults(view: { locale: MonitorLocale; params: LandingParams; facets: Facets; deputies: number }) {
  const result = await runSearch(getServer().db, view.params, translator(), (q) => semanticSearch(q));
  return <LandingView {...view} result={result} />;
}
