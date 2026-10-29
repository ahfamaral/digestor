import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@digestor/core/server";
import { AppBar, type Step } from "@/components/AppBar";
import { Processing } from "@/components/Processing";
import { getServer } from "@/lib/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stage router: the session row decides which screen shows. Reads the DB per request (Cache Components: inside Suspense). */
export default function SessionPage({ params }: PageProps<"/s/[id]">) {
  return (
    <Suspense fallback={<AppBar />}>
      <SessionScreen params={params} />
    </Suspense>
  );
}

async function SessionScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await getSession(getServer().db, id);
  if (!session) notFound();

  const stage = session.stage;
  let current: Step = "Processing";
  let body: React.ReactNode;
  if (stage === "awaiting_context") {
    current = "Context";
    body = <Placeholder>Context check (coming next)</Placeholder>; // Task 14
  } else if (stage === "awaiting_review" || stage === "done") {
    current = "Review";
    body = <Placeholder>Review (coming next)</Placeholder>; // Task 15
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

function Placeholder({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border bg-white p-6 text-sm text-muted-foreground">{children}</div>;
}
