import { Suspense } from "react";
import { notFound } from "next/navigation";
import { OWNER_ID, exportChecklist } from "@digestor/core";
import { getMoment, getSession, listClips, listTracks } from "@digestor/core/server";
import { AppBar } from "@/components/AppBar";
import { ExportList, type ExportClipData } from "@/components/ExportList";
import { exportRows } from "@/lib/exportRows";
import { isUuid } from "@/lib/ids";
import { asProfile } from "@/lib/preview";
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
  const data: ExportClipData[] = await Promise.all(
    clips.map(async (clip) => {
      const [moment, tracks] = await Promise.all([clip.momentId ? getMoment(db, clip.momentId) : null, listTracks(db, clip.id)]);
      const failing = exportChecklist({ clip, checks: moment?.checks ?? null, tracks, profile })
        .filter((i) => !i.ok)
        .map((i) => i.id);
      return {
        id: clip.id,
        title: moment?.title ?? "",
        startMs: clip.startMs,
        endMs: clip.endMs,
        failing,
        row: exportRows([clip], tracks)[0]!,
      };
    }),
  );

  return (
    <ExportList
      session={{ id: session.id, title: session.title, language: session.language, videoRemoved: session.videoDeletedAt !== null }}
      clips={data}
    />
  );
}
