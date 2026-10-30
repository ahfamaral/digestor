import { Suspense } from "react";
import Link from "next/link";
import { OWNER_ID } from "@digestor/core";
import { getSession, listProblemReports } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { getServer } from "@/lib/server";
import { formatDateTime, t } from "@/lib/i18n";

/** The owner's "Report a problem" submissions, newest first. Reads the DB per request (inside Suspense). */
export default function ReportsPage() {
  return (
    <>
      <AppBar />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-xl font-bold tracking-tight">{t("reports.title")}</h1>
        <Suspense fallback={null}>
          <ReportList />
        </Suspense>
      </main>
    </>
  );
}

async function ReportList() {
  const { db } = getServer();
  const reports = await listProblemReports(db, OWNER_ID);
  if (reports.length === 0) return <p className="text-sm text-muted-foreground">{t("reports.empty")}</p>;
  const ids = [...new Set(reports.map((r) => r.sessionId))];
  const titles = new Map((await Promise.all(ids.map((id) => getSession(db, id)))).flatMap((s) => (s ? [[s.id, s.title] as const] : [])));
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-white">
      {reports.map((r) => (
        <li key={r.id} className="grid gap-1 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-semibold text-stone-800">{t(`reports.kind.${r.targetKind}`)}</span>
            {titles.has(r.sessionId) ? (
              <Link href={`/s/${r.sessionId}`} dir="auto" className="min-w-0 font-medium break-words underline-offset-2 hover:underline">
                {titles.get(r.sessionId)}
              </Link>
            ) : (
              <span className="text-muted-foreground">{t("reports.unknownSession")}</span>
            )}
            <time dateTime={new Date(r.createdAt).toISOString()} className="ml-auto font-mono text-xs text-muted-foreground">
              {formatDateTime(r.createdAt)}
            </time>
          </div>
          <p dir="auto" className={r.note ? "break-words" : "text-muted-foreground"}>
            {r.note || t("reports.noNote")}
          </p>
        </li>
      ))}
    </ul>
  );
}
