import { Suspense } from "react";
import { PROFILES, isProxyReady } from "@digestor/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getContextCard, getCurrentAnalysis, getRunningAnalysis, getSession, getTranscript, listAnalysisVersions, type Session,
} from "@digestor/core/server";
import { AppBar, type Step } from "@/components/AppBar";
import { ContextCheck } from "@/components/ContextCheck";
import { Preview } from "@/components/Preview/Preview";
import { Processing } from "@/components/Processing";
import { isUuid } from "@/lib/ids";
import { asProfile, latestFailedAfter, versionNote } from "@/lib/preview";
import { loadNames, namesChangedSince } from "@/lib/namesServer";
import { namedCount, rangeVoices, whosWhoRows } from "@/lib/names";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";

/** Stage router: the session row decides which screen shows (later screens arrive in later tasks). Reads the DB per request (Cache Components: inside Suspense). */
export default function SessionPage({ params, searchParams }: PageProps<"/s/[id]">) {
  return (
    <Suspense fallback={<AppBar />}>
      <SessionScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function SessionScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const openReanalyze = (await searchParams).reanalyze === "1";
  if (!isUuid(id)) notFound();
  const session = await getSession(getServer().db, id);
  if (!session) notFound();

  const stage = session.stage;
  if (stage === "ready") return <PreviewScreen session={session} openReanalyze={openReanalyze} />;
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
        <Link href="/" className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white">
          {t("session.startOver")}
        </Link>
      </div>
    );
  } else {
    body = (
      <Processing
        sessionId={session.id}
        source={session.source}
        hasVideo={session.hasVideo}
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

/** Preview: the current analysis (topics, moments, briefing) plus its version history and any running re-analysis. */
async function PreviewScreen({ session, openReanalyze }: { session: Session; openReanalyze: boolean }) {
  const { db } = getServer();
  const [bundle, versions, running, context, names, transcript] = await Promise.all([
    getCurrentAnalysis(db, session.id),
    listAnalysisVersions(db, session.id),
    getRunningAnalysis(db, session.id),
    getContextCard(db, session.id),
    loadNames(db, session.id),
    getTranscript(db, session.id),
  ]);
  if (!bundle) {
    return (
      <>
        <AppBar current="Preview" />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
          <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
          <p role="alert" className="text-sm text-red-700">{t("session.analysisMissing")}</p>
        </main>
      </>
    );
  }
  const { topics, moments, briefing } = bundle;
  const namesChanged = await namesChangedSince(db, session.id, bundle.version.namesAt);
  const durationMs = session.durationMs ?? topics.at(-1)?.endMs ?? 0;
  const words = transcript?.words ?? [];
  const speakerIds = [...new Set(words.length > 0 ? words.map((w) => w.speaker) : moments.flatMap((m) => m.speakers))].sort();
  const speakers = speakerIds.length || context?.card.participants.length || 0;
  const sensitive = PROFILES[asProfile(bundle.version.profile)].sensitive;
  const voices = Object.fromEntries(moments.map((m) => [m.id, rangeVoices(names, words, m, sensitive, m.speakers)]));
  return (
    <>
      <AppBar current="Preview" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <Preview
          key={bundle.version.id}
          session={{
            id: session.id,
            title: session.title,
            durationMs,
            language: session.language,
            hasVideo: session.hasVideo,
            videoRemoved: session.videoDeletedAt !== null,
          }}
          analysis={{
            id: bundle.version.id,
            version: bundle.version.version,
            profile: asProfile(bundle.version.profile),
            note: versionNote(versions, bundle.version.id),
            running: running !== null,
            failedVersion: latestFailedAfter(versions, bundle.version.id),
          }}
          speakers={speakers}
          named={namedCount(names, speakerIds, sensitive)}
          namesChanged={namesChanged}
          openReanalyze={openReanalyze}
          names={names}
          whoRows={whosWhoRows(names, words)}
          voices={voices}
          topics={topics}
          moments={moments}
          briefing={briefing}
          card={context?.card ?? null}
        />
      </main>
    </>
  );
}
