import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HIGHLIGHT_TYPES, OWNER_ID, PROFILES, speakersIn, type HighlightTypeId, type SelectionStatus } from "@digestor/core";
import {
  countSelectionsByAnalysis, getCurrentAnalysis, getSession, getTranscript, listPersonalMoments, listSelections,
} from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { FullBriefing } from "@/components/Briefing/FullBriefing";
import { earlierSelections, momentExcerpt, speakerOptions } from "@/lib/briefingData";
import { isUuid } from "@/lib/ids";
import { asProfile } from "@/lib/preview";
import { getServer } from "@/lib/server";
import { t } from "@/lib/i18n";

/** Full briefing: every moment of the current analysis, filtered on screen. Reads the DB per request (inside Suspense). */
export default function BriefingPage({ params }: PageProps<"/s/[id]/briefing">) {
  return (
    <Suspense fallback={<AppBar current="Briefing" />}>
      <BriefingScreen params={params} />
    </Suspense>
  );
}

async function BriefingScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { db } = getServer();
  const session = await getSession(db, id);
  if (!session) notFound();

  const bundle = session.stage === "ready" ? await getCurrentAnalysis(db, id) : null;
  if (!bundle) {
    return (
      <>
        <AppBar current="Briefing" />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
          <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
          <p role="alert" className="mb-3 text-sm text-red-700">
            {session.stage === "ready" ? t("session.analysisMissing") : t("briefing.notReady")}
          </p>
          <Link href={`/s/${id}`} className="text-sm underline underline-offset-2">
            {t("briefing.backToSession")}
          </Link>
        </main>
      </>
    );
  }

  const analysisId = bundle.version.id;
  const [personal, selections, byVersion, transcript] = await Promise.all([
    listPersonalMoments(db, OWNER_ID, analysisId),
    listSelections(db, OWNER_ID, id),
    countSelectionsByAnalysis(db, OWNER_ID, id),
    getTranscript(db, id),
  ]);
  const words = transcript?.words ?? [];
  // Personal moments are stored without speakers; take them from the transcript so Focus finds them too.
  const moments = [
    ...bundle.moments,
    ...personal.map((m) => (m.speakers.length > 0 ? m : { ...m, speakers: speakersIn(words, m) })),
  ];
  const ids = new Set(moments.map((m) => m.id));
  const current: Record<string, SelectionStatus> = Object.fromEntries(Object.entries(selections).filter(([momentId]) => ids.has(momentId)));
  const excerpts = Object.fromEntries(moments.map((m) => [m.id, momentExcerpt(words, m)]));
  const profile = asProfile(bundle.version.profile);
  const present = new Set(moments.flatMap((m) => m.highlights.map((h) => h.type)));
  const types = [...new Set([...PROFILES[profile].highlightTypes, ...present])].filter((x): x is HighlightTypeId => x in HIGHLIGHT_TYPES);

  return (
    <FullBriefing
      key={analysisId}
      session={{
        id: session.id,
        title: session.title,
        language: session.language,
        hasVideo: session.hasVideo,
        videoRemoved: session.videoDeletedAt !== null,
      }}
      analysis={{ id: analysisId, version: bundle.version.version }}
      topics={bundle.topics}
      moments={moments}
      excerpts={excerpts}
      selections={current}
      speakers={speakerOptions(words, moments.flatMap((m) => m.speakers))}
      types={types}
      earlier={earlierSelections(byVersion, analysisId)}
    />
  );
}
