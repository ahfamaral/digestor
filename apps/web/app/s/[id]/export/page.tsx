import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { getSession, listClips } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { ExportList } from "@/components/ExportList";
import { isUuid } from "@/lib/ids";
import { approvedClips, buildClipTree } from "@/lib/review";
import { getServer } from "@/lib/server";

/** Export: approved clips with their render status and downloads. Reads the DB per request (inside Suspense). */
export default function ExportPage({ params }: PageProps<"/s/[id]/export">) {
  return (
    <Suspense fallback={<AppBar current="Export" />}>
      <ExportScreen params={params} />
    </Suspense>
  );
}

async function ExportScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { db } = getServer();
  const session = await getSession(db, id);
  if (!session) notFound();
  // Nothing has been rendered before the render step: the stage router shows the right screen.
  if (session.stage !== "rendering" && session.stage !== "done") redirect(`/s/${id}`);
  const clips = approvedClips(buildClipTree(await listClips(db, id)));

  return (
    <>
      <AppBar current="Export" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
        <div className="flex flex-col items-start gap-4 md:flex-row">
          <section aria-label="Approved clips" className="w-full rounded-xl border border-border bg-white px-4 py-1 md:flex-[1.6]">
            <ExportList sessionId={id} language={session.language} initialStage={session.stage} initialClips={clips} />
          </section>
          <aside className="w-full rounded-xl border border-border bg-white p-4 md:flex-1">
            <h2 className="text-sm font-bold">Render options</h2>
            <label className="mt-3 flex items-center gap-2 text-sm">
              {/* Subtitles are always burned in for now. */}
              <input type="checkbox" checked disabled readOnly className="size-4 accent-foreground" />
              Burn in subtitles
            </label>
            <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
              You&apos;re responsible for how you use and share downloaded clips.
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
