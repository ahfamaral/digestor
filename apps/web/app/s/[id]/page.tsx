import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getContextCard, getSession, listClips } from "@digestor/core/server";
import { AppBar, type Step } from "@/components/AppBar";
import { ContextCheck } from "@/components/ContextCheck";
import { Inbox } from "@/components/Inbox";
import { Processing } from "@/components/Processing";
import { isUuid } from "@/lib/ids";
import { buildClipTree } from "@/lib/review";
import { getServer } from "@/lib/server";

/** Stage router: the session row decides which screen shows (rendering goes to /export). Reads the DB per request (Cache Components: inside Suspense). */
export default function SessionPage({ params }: PageProps<"/s/[id]">) {
  return (
    <Suspense fallback={<AppBar />}>
      <SessionScreen params={params} />
    </Suspense>
  );
}

async function SessionScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const session = await getSession(getServer().db, id);
  if (!session) notFound();

  const stage = session.stage;
  // While rendering, the export page shows per-clip progress.
  if (stage === "rendering") redirect(`/s/${id}/export`);
  if (stage === "awaiting_review" || stage === "done") {
    // The inbox owns its app bar ("Render N approved →" follows the live triage state).
    const { db } = getServer();
    const [rows, found] = await Promise.all([listClips(db, id), getContextCard(db, id)]);
    return <Inbox sessionId={session.id} title={session.title} initialTree={buildClipTree(rows)} card={found?.card ?? null} />;
  }
  let current: Step = "Processing";
  let body: React.ReactNode;
  if (stage === "awaiting_context") {
    current = "Context";
    const found = await getContextCard(getServer().db, id);
    body = found ? (
      <ContextCheck sessionId={session.id} card={found.card} />
    ) : (
      <div role="alert" className="rounded-xl border border-border bg-white p-5 text-sm text-red-700">
        The context card is missing for this video. Start over from the upload page.
      </div>
    );
  } else if (stage === "failed") {
    body = (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-white p-5">
        <h2 className="mb-1 text-base font-bold">Something went wrong</h2>
        <p className="mb-4 text-sm text-muted-foreground">{session.error ?? "The video could not be processed."}</p>
        <Link href="/" className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white">
          Start over
        </Link>
      </div>
    );
  } else {
    body = (
      <Processing
        sessionId={session.id}
        source={session.source}
        initial={{ stage, progress: session.progress, language: session.language, eventType: session.eventType }}
      />
    );
  }

  return (
    <>
      <AppBar current={current} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
        {body}
      </main>
    </>
  );
}
