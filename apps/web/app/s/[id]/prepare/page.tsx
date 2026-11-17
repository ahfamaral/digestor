import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OWNER_ID, PROFILES, cutsMidSentence, findBoundaries } from "@digestor/core";
import { getMoment, getSession, getTranscript, listClipEvents, listClips, listSelections, listTracks } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { PrepareList, type PrepareClipData } from "@/components/Prepare/PrepareList";
import { isUuid } from "@/lib/ids";
import { approvalDismissed, undoStep, defaultCredit, toClipView, toTrackView } from "@/lib/prepareData";
import { asProfile } from "@/lib/preview";
import { getServer } from "@/lib/server";
import { loadNames } from "@/lib/namesServer";
import { currentSpeakerTitle } from "@/lib/briefingData";
import { rangeVoices, whosWhoRows } from "@/lib/names";
import { cutPoints, trimView } from "@/lib/trim";
import { t } from "@/lib/i18n";

/** Prepare clips: trim, checks, format, credit and subtitles for each confirmed clip. Reads the DB per request (inside Suspense). */
export default function PreparePage({ params }: PageProps<"/s/[id]/prepare">) {
  return (
    <Suspense fallback={<AppBar current="Prepare" />}>
      <PrepareScreen params={params} />
    </Suspense>
  );
}

async function PrepareScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { db } = getServer();
  const session = await getSession(db, id);
  if (!session) notFound();

  if (session.stage !== "ready") {
    return (
      <>
        <AppBar current="Prepare" session={{ id: session.id, ready: false }} />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
          <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{session.title}</h1>
          <p role="alert" className="mb-3 text-sm text-red-700">
            {t("briefing.notReady")}
          </p>
          <Link href={`/s/${id}`} className="text-sm underline underline-offset-2">
            {t("briefing.backToSession")}
          </Link>
        </main>
      </>
    );
  }

  const clips = await listClips(db, OWNER_ID, id);
  const selections = await listSelections(db, OWNER_ID, id);
  const transcript = clips.length > 0 ? await getTranscript(db, id) : null;
  const durationMs = session.durationMs ?? transcript?.durationMs ?? Math.max(0, ...clips.map((c) => c.endMs));
  // Boundaries are computed here and only the clip's window (± 30 s) is sent, as plain numbers.
  const names = await loadNames(db, id);
  const sensitive = PROFILES[asProfile(session.profile)].sensitive;
  const boundaries = transcript ? findBoundaries(transcript.words, durationMs) : [];

  const data: PrepareClipData[] = await Promise.all(
    clips.map(async (clip) => {
      const [moment, tracks, events] = await Promise.all([
        clip.momentId ? getMoment(db, clip.momentId) : null,
        listTracks(db, clip.id),
        listClipEvents(db, clip.id),
      ]);
      const view = trimView(clip, durationMs);
      return {
        clip: toClipView({ ...clip, midSentence: boundaries.length >= 2 && cutsMidSentence(boundaries, clip) }),
        title: moment ? currentSpeakerTitle(moment, names, sensitive) : "",
        checks: moment?.checks ?? null,
        momentRange: moment ? { startMs: moment.startMs, endMs: moment.endMs } : null,
        tracks: tracks.map(toTrackView),
        points: cutPoints(boundaries, view.viewStart, view.viewEnd),
        undo: undoStep(events),
        voices: rangeVoices(names, transcript?.words ?? [], clip, sensitive, moment?.speakers ?? []),
        speakerWords: transcript
          ? transcript.words
              .filter((w) => w.endMs > view.viewStart && w.startMs < view.viewEnd)
              .map((w) => ({ startMs: w.startMs, endMs: w.endMs, speaker: w.speaker }))
          : [],
        thumbUrl: moment?.thumbKey ? `/api/files/${id}/thumbs/${moment.id}.jpg` : null,
        dismissed: approvalDismissed(clip, selections),
        mergedCount: (clip.momentId ? 1 : 0) + clip.mergedMomentIds.length,
      };
    }),
  );

  return (
    <PrepareList
      session={{
        id: session.id,
        title: session.title,
        language: session.language,
        durationMs,
        hasVideo: session.hasVideo,
        videoRemoved: session.videoDeletedAt !== null,
        profile: asProfile(session.profile),
      }}
      defaultCredit={defaultCredit(session)}
      names={names}
      whoRows={whosWhoRows(names, transcript?.words ?? [])}
      clips={data}
    />
  );
}
