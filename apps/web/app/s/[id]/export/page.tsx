import { Suspense } from "react";
import { notFound } from "next/navigation";
import { OWNER_ID, PROFILES, exportChecklist, speakersInRange } from "@digestor/core";
import { getMoment, getSession, getTranscript, listClips, listSelections, listTracks } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { ExportList, type ExportClipData } from "@/components/ExportList";
import { exportRows } from "@/lib/exportRows";
import { approvalDismissed } from "@/lib/prepareData";
import { isUuid } from "@/lib/ids";
import { asProfile } from "@/lib/preview";
import { loadNames } from "@/lib/namesServer";
import { currentSpeakerTitle } from "@/lib/briefingData";
import { rangeVoices, unconfirmedAcrossClips, whosWhoRows } from "@/lib/names";
import { getServer } from "@/lib/server";

/** Export: checklist status, render start and downloads per clip. Reads the DB per request (inside Suspense). */
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

  const profile = asProfile(session.profile);
  const clips = await listClips(db, OWNER_ID, id);
  const selections = await listSelections(db, OWNER_ID, id);
  const [names, transcript] = clips.length > 0 ? await Promise.all([loadNames(db, id), getTranscript(db, id)]) : [{ persons: [], attributions: [] }, null];
  const sensitive = PROFILES[profile].sensitive;
  const data: ExportClipData[] = await Promise.all(
    clips.map(async (clip) => {
      const [moment, tracks] = await Promise.all([clip.momentId ? getMoment(db, clip.momentId) : null, listTracks(db, clip.id)]);
      const failing = exportChecklist({ clip, moment, tracks, profile, speakers: speakersInRange(transcript?.words ?? [], names.attributions, clip) })
        .filter((i) => !i.ok)
        .map((i) => i.id);
      return {
        id: clip.id,
        title: moment ? currentSpeakerTitle(moment, names, sensitive) : "",
        startMs: clip.startMs,
        endMs: clip.endMs,
        failing,
        dismissed: approvalDismissed(clip, selections),
        voices: rangeVoices(names, transcript?.words ?? [], clip, sensitive, moment?.speakers ?? []),
        row: exportRows([{ ...clip, cleared: failing.length === 0 }], tracks)[0]!,
      };
    }),
  );

  const words = transcript?.words ?? [];
  const unconfirmed = unconfirmedAcrossClips(
    clips.map((c, i) => ({ startMs: c.startMs, endMs: c.endMs, words, dismissed: data[i]!.dismissed })),
    names,
    sensitive,
  );

  return (
    <ExportList
      session={{ id: session.id, title: session.title, language: session.language, videoRemoved: session.videoDeletedAt !== null, sensitive, hasVideo: session.hasVideo }}
      names={names}
      whoRows={whosWhoRows(names, words)}
      unconfirmed={unconfirmed}
      profile={profile}
      clips={data}
    />
  );
}
