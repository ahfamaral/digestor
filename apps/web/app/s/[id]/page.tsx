import { Suspense } from "react";
import { isProxyReady } from "@digestor/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getContextCard, getSession, getTranscript, type Session } from "@digestor/core/server";
import { AppBar, type Step } from "@/components/AppBar";
import { ContextCheck } from "@/components/ContextCheck";
import { Briefing } from "@/components/Briefing/Briefing";
import { Processing } from "@/components/Processing";
import { isUuid } from "@/lib/ids";
import { loadBriefingPage } from "@/lib/briefingPage";
import { loadNames } from "@/lib/namesServer";
import { whosWhoRows } from "@/lib/names";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";

/** Stage router: the session row decides which screen shows (later screens arrive in later tasks). Reads the DB per request (Cache Components: inside Suspense). */
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
  if (stage === "ready") return <BriefingScreen session={session} />;
  let current: Step = "Processing";
  let body: React.ReactNode;
  if (stage === "awaiting_context") {
    current = "Context";
    const { db } = getServer();
    const [found, names, transcript] = await Promise.all([getContextCard(db, id), loadNames(db, id), getTranscript(db, id)]);
    body = found ? (
      <ContextCheck sessionId={session.id} card={found.card} names={names} rows={whosWhoRows(names, transcript?.words ?? [])} proxyReady={isProxyReady(session)} />
    ) : (
      <div role="alert" className="rounded-xl border border-border bg-white p-5 text-sm text-red-700">
        {t("session.contextMissing")}
      </div>
    );
  } else if (stage === "failed") {
    body = (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-white p-5">
        <h2 className="mb-1 text-base font-bold">{t("session.failedTitle")}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{session.error ?? t("session.failedFallback")}</p>
        <Link href="/new" className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white">
          {t("session.startOver")}
        </Link>
      </div>
    );
  } else {
    body = (
      <Processing
        sessionId={session.id}
        source={session.source}
        hasVideo={session.hasVideo && !session.audioOnlyAck}
        initial={{ stage, progress: session.progress, language: session.language, profile: session.profile }}
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

/** The Briefing page: the current analysis with its summary on top and the moment tree underneath. */
async function BriefingScreen({ session }: { session: Session }) {
  const props = await loadBriefingPage(getServer().db, session);
  return (
    <>
      <AppBar current="Briefing" />
      <main className={props ? "mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6" : "mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6"}>
        {props ? (
          <Briefing key={props.analysis.id} {...props} />
        ) : (
          <>
            <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
            <p role="alert" className="text-sm text-red-700">{t("session.analysisMissing")}</p>
          </>
        )}
      </main>
    </>
  );
}
