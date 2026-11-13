import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { AppBar } from "@/components/AppBar";
import { AskRecordView } from "@/components/Monitor/AskRecordView";
import { askRecord } from "@/lib/monitor/askRecord";
import type { MonitorLocale } from "@/lib/monitor/i18n";
import { askHref, parseAsk, type AskParams } from "@/lib/monitor/params";
import { requestLocale, translator } from "@/lib/monitor/server";
import { monitorTitle } from "@/lib/monitor/titles";
import { tm } from "@/lib/monitor/i18n";
import { getServer } from "@/lib/server";

/** The tab names the question, so tabs and history entries can be told apart. */
export async function generateMetadata({ searchParams }: PageProps<"/monitor/perguntar">): Promise<Metadata> {
  const params = parseAsk(await searchParams);
  const locale = await requestLocale();
  return { title: monitorTitle(locale, params.q, tm(locale, "ask.title")) };
}

/** "Ask the record": passages quoted from the official speeches for a question. Reads the DB per request (inside Suspense). */
export default function AskRecordPage({ searchParams }: PageProps<"/monitor/perguntar">) {
  return (
    <>
      <AppBar area="monitor" skipTo="content" />
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none sm:px-6">
        <Suspense fallback={null}>
          <AskScreen searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function AskScreen({ searchParams }: { searchParams: PageProps<"/monitor/perguntar">["searchParams"] }) {
  await connection();
  const raw = await searchParams;
  const params = parseAsk(raw);
  const locale = await requestLocale();
  // Sent without a question: say what to type.
  if (!params.q) return <AskRecordView locale={locale} params={params} result={null} askedEmpty={"q" in raw} />;
  // The question is translated (for the word half of the search) and scored by the worker: the form shows at once.
  return (
    <Suspense key={askHref(params)} fallback={<AskRecordView locale={locale} params={params} result={null} searching />}>
      <AskResults locale={locale} params={params} />
    </Suspense>
  );
}

async function AskResults({ locale, params }: { locale: MonitorLocale; params: AskParams }) {
  const result = await askRecord(getServer().db, params.q, {
    from: params.from ?? undefined, to: params.to ?? undefined, translate: translator(),
  });
  return <AskRecordView locale={locale} params={params} result={result} />;
}
