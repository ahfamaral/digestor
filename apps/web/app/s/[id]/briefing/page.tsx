import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HIGHLIGHT_TYPES, OWNER_ID, PROFILES, personAt, speakersIn, type HighlightTypeId, type SelectionStatus } from "@digestor/core";
import {
  countSelectionsByAnalysis, getCurrentAnalysis, getSession, getTranscript, listPersonalMoments, listSelections,
} from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { FullBriefing } from "@/components/Briefing/FullBriefing";
import { earlierSelections, focusOptions, momentExcerpt, peopleByMoment } from "@/lib/briefingData";
import { loadNames, namesChangedSince } from "@/lib/namesServer";
import { labelText, rangeVoices, voiceLabel, whosWhoRows } from "@/lib/names";
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
  const namesChanged = await namesChangedSince(db, id, bundle.version.namesAt);
  const [personal, selections, byVersion, transcript, names] = await Promise.all([
    listPersonalMoments(db, OWNER_ID, analysisId),
    listSelections(db, OWNER_ID, id),
    countSelectionsByAnalysis(db, OWNER_ID, id),
    getTranscript(db, id),
    loadNames(db, id),
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
  const sensitive = PROFILES[profile].sensitive;
  const voices = Object.fromEntries(moments.map((m) => [m.id, rangeVoices(names, words, m, sensitive, m.speakers)]));
  // Focus: people by share, then the voices with no name to show. A label is resolved where its person (or voice) first speaks.
  // One pass over the words: the label of each person / voice where it first speaks.
  const firstLabel = new Map<string, ReturnType<typeof voiceLabel>>();
  for (const w of words) {
    const res = personAt(names.attributions, w.speaker, w.startMs);
    for (const key of [`v:${w.speaker}`, ...(res.kind === "named" ? [`p:${res.personId}`] : [])]) {
      if (!firstLabel.has(key)) firstLabel.set(key, voiceLabel(names, w.speaker, w.startMs, sensitive));
    }
  }
  const choices = focusOptions(names, words, sensitive).map((o) => {
    const label = firstLabel.get(o.kind === "person" ? `p:${o.personId}` : `v:${o.speakerId}`);
    return o.kind === "person"
      ? { kind: "person" as const, id: o.personId, share: o.share, name: label ? labelText(label) : (names.persons.find((p) => p.id === o.personId)?.displayName ?? "") }
      : { kind: "voice" as const, id: o.speakerId, share: o.share, name: label ? labelText(label) : `Speaker ${o.speakerId}` };
  });
  const people = Object.fromEntries([...peopleByMoment(moments, names, words, sensitive)].map(([id, set]) => [id, [...set]]));
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
      choices={choices}
      people={people}
      names={names}
      namesChanged={namesChanged}
      whoRows={whosWhoRows(names, words)}
      voices={voices}
      sensitive={sensitive}
      types={types}
      earlier={earlierSelections(byVersion, analysisId)}
    />
  );
}
