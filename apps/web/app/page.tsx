import type { Metadata } from "next";
import { pageTitle } from "@/lib/pageTitle";
import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { OWNER_ID, sessionSpending, totalSpending } from "@digestor/core";
import { getContextCard, listClipPreviews, listSessionSummaries, listSpendingRows } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { HomeTable, type ClipPreviewView } from "@/components/Home/HomeTable";
import { LibraryAsk } from "@/components/Home/LibraryAsk";
import { filtersToQuery, parseFilters, type HomeRow } from "@/lib/home";
import { displayTitle, looksLikeFileName } from "@/lib/sessionTitle";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";
import { spentSoFarText } from "@/lib/cost";

const SESSION_LIMIT = 200;

/** Sessions: every ingested video, with where it is and its clips. Reads the DB per request (inside Suspense). */
export const metadata: Metadata = { title: pageTitle(t("home.title")) };

export default function SessionsPage({ searchParams }: PageProps<"/">) {
  return (
    <>
      <AppBar />
      <main id="content" tabIndex={-1} className="outline-none mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight">{t("home.title")}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <LibraryAsk />
            <Link
              href="/new"
              className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t("home.newVideo")}
            </Link>
          </div>
        </div>
        <Suspense fallback={null}>
          <Sessions searchParams={searchParams} />
        </Suspense>
      </main>
    </>
  );
}

async function Sessions({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await connection();
  const { db } = getServer();
  const summaries = await listSessionSummaries(db, OWNER_ID, SESSION_LIMIT);
  const [previews, contextTitles, spending] = await Promise.all([
    listClipPreviews(db, OWNER_ID, summaries.map((s) => s.id)),
    // Only rows whose title is a file name ("globo-debate-lula-flavio") read their context check's title.
    Promise.all(
      summaries.filter((s) => looksLikeFileName(s.title)).map(async (s) => [s.id, (await getContextCard(db, s.id))?.card.title.value ?? null] as const),
    ).then((pairs) => new Map(pairs)),
    // "Spent so far": every session's recorded analysis dollars plus the estimates for what isn't recorded.
    listSpendingRows(db).then((rows) => totalSpending(rows.map(sessionSpending))),
  ]);
  const rows: HomeRow[] = summaries.map((s) => ({
    ...s,
    title: displayTitle(s.title, contextTitles.get(s.id)),
    createdAt: s.createdAt.toISOString(),
    lastActivityAt: s.lastActivityAt.toISOString(),
  }));
  const clips: Record<string, ClipPreviewView[]> = {};
  for (const c of previews) {
    (clips[c.sessionId] ??= []).push({ ...c, thumbUrl: c.thumbKey && c.momentId ? `/api/files/${c.sessionId}/thumbs/${c.momentId}.jpg` : null });
  }
  const initial = parseFilters(await searchParams);
  return <HomeTable key={filtersToQuery(initial)} rows={rows} clips={clips} now={new Date().toISOString()} initial={initial} limit={SESSION_LIMIT} spent={spending.bestUsd > 0 ? spentSoFarText(spending) : null} />;
}
