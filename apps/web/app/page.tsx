import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { OWNER_ID } from "@digestor/core";
import { listClipPreviews, listSessionSummaries } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { HomeTable, type ClipPreviewView } from "@/components/Home/HomeTable";
import { parseFilters, type HomeRow } from "@/lib/home";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";

/** Sessions: every ingested video, with where it is and its clips. Reads the DB per request (inside Suspense). */
export default function SessionsPage({ searchParams }: PageProps<"/">) {
  return (
    <>
      <AppBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight">{t("home.title")}</h1>
          <Link
            href="/new"
            className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t("home.newVideo")}
          </Link>
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
  const summaries = await listSessionSummaries(db, OWNER_ID);
  const previews = await listClipPreviews(db, OWNER_ID, summaries.map((s) => s.id));
  const rows: HomeRow[] = summaries.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), lastActivityAt: s.lastActivityAt.toISOString() }));
  const clips: Record<string, ClipPreviewView[]> = {};
  for (const c of previews) {
    (clips[c.sessionId] ??= []).push({ ...c, thumbUrl: c.thumbKey && c.momentId ? `/api/files/${c.sessionId}/thumbs/${c.momentId}.jpg` : null });
  }
  return <HomeTable rows={rows} clips={clips} now={new Date().toISOString()} initial={parseFilters(await searchParams)} />;
}
