"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LANGUAGES, formatLength, formatTimestamp, type ChecklistId } from "@digestor/core";
import { SpeakerName } from "@/components/Names/SpeakerName";
import type { NamesData, Voice } from "@/lib/names";
import { AppBar } from "@/components/AppBar";
import { WarningIcon } from "@/components/WarningNote";
import { inFlight, type ExportLanguageRow, type ExportRow } from "@/lib/exportRows";
import { languageName, t } from "@/lib/i18n";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { cn } from "@/lib/utils";

export const EXPORT_POLL_MS = 3000;

export interface ExportClipData {
  id: string;
  /** The clip's moment title (in the spoken language). */
  title: string;
  startMs: number;
  endMs: number;
  /** Checklist items that don't hold yet. Empty = ready to export. */
  failing: ChecklistId[];
  /** Voices of the clip whose name is not confirmed yet, as the screens show them ("Speaker C"). */
  unconfirmed: string[];
  /** Who speaks in the clip (longest first). */
  voices: Voice[];
  row: ExportRow;
}

export interface ExportListProps {
  session: { id: string; title: string; language: string | null; videoRemoved: boolean; sensitive: boolean };
  names: NamesData;
  clips: ExportClipData[];
}

const LINK =
  "inline-flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-semibold outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-brand";
const NOTICE = "mb-3 rounded-lg border px-3 py-2 text-sm";

const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? languageName(code);

/** Export: each prepared clip with its checklist, the Export button, and every download (MP4, SRT/VTT, burned-in). */
export function ExportList({ session, names, clips }: ExportListProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const lang = session.language ?? undefined;
  const ready = clips.filter((c) => c.failing.length === 0);
  const polling = inFlight(clips.map((c) => c.row));

  // Refresh the server data every 3 s while anything is queued or rendering; stops itself when nothing is in flight.
  useEffect(() => {
    if (!polling) return;
    return startRefreshLoop(() => router.refresh(), EXPORT_POLL_MS);
  }, [polling, router]);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipIds: ready.map((c) => c.id) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; queued?: number; burns?: number; blocked?: unknown[] };
      if (!res.ok) {
        setMessage({ kind: "error", text: data.error ?? t("exportScreen.failed") });
      } else if ((data.queued ?? 0) + (data.burns ?? 0) === 0) {
        setMessage({ kind: "ok", text: t("exportScreen.nothingNew") });
      } else {
        const blocked = (data.blocked ?? []).length > 0 ? ` ${t("exportScreen.blockedSome")}` : "";
        setMessage({ kind: "ok", text: `${(data.burns ?? 0) > 0 ? t("exportScreen.startedBurns") : t("exportScreen.started")}${blocked}` });
      }
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: t("exportScreen.failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppBar current="Export" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6">
        <header className="mb-3">
          <Link
            href={`/s/${session.id}/prepare`}
            className="text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand"
          >
            {t("exportScreen.backToPrepare")}
          </Link>
          <h1 lang={lang} dir="auto" className="mt-1 text-xl font-bold tracking-tight break-words">
            {session.title}
          </h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {t("exportScreen.title")} · {clips.length === 1 ? t("exportScreen.clipsOne") : t("exportScreen.clipsMany", { n: clips.length })}
          </p>
        </header>

        {session.videoRemoved && (
          <p id="video-removed" role="status" className={`${NOTICE} border-border bg-stone-100 text-stone-800`}>
            {t("preview.videoRemoved")}
          </p>
        )}
        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={cn(NOTICE, message.kind === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-green-200 bg-green-50 text-green-900")}
          >
            {message.text}
          </p>
        )}

        {clips.length === 0 ? (
          <div className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
            <p>{t("exportScreen.noClips")}</p>
            <Link href={`/s/${session.id}/briefing`} className="mt-2 inline-block text-foreground underline underline-offset-2">
              {t("exportScreen.openBriefing")}
            </Link>
          </div>
        ) : (
          <ol className="grid gap-3">
            {clips.map((clip, n) => (
              <ClipRow key={clip.id} n={n + 1} clip={clip} sessionId={session.id} lang={lang} names={names} sensitive={session.sensitive} />
            ))}
          </ol>
        )}

        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">{t("exportScreen.notice")}</p>

        <footer className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <span className="text-sm font-medium text-muted-foreground">{t("exportScreen.readyCount", { n: ready.length, total: clips.length })}</span>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy || session.videoRemoved || ready.length === 0}
              aria-describedby={session.videoRemoved ? "video-removed" : undefined}
              className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? t("exportScreen.exporting") : t("exportScreen.exportReady")}
            </button>
          </div>
        </footer>
      </main>
    </>
  );
}

function ClipRow({
  n, clip, sessionId, lang, names, sensitive,
}: {
  n: number;
  clip: ExportClipData;
  sessionId: string;
  lang: string | undefined;
  names: NamesData;
  sensitive: boolean;
}) {
  const { row } = clip;
  const heading = clip.title || t("exportScreen.clipHeading", { n });
  const status = t(`exportScreen.status.${row.renderStatus}`);
  const bad = row.renderStatus === "failed";
  return (
    <li data-clip-id={clip.id} className="rounded-xl border border-border bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">
            {t("exportScreen.clipHeading", { n })} · {t("exportScreen.clipLength", { start: formatTimestamp(clip.startMs), length: formatLength(clip.endMs - clip.startMs) })}
          </p>
          <h2 lang={lang} dir="auto" className="text-base font-semibold break-words">
            {heading}
          </h2>
          {clip.voices.length > 0 && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span className="sr-only">{t("briefing.speakers")}: </span>
              {clip.voices.map((v) => (
                <SpeakerName
                  key={`${v.speakerId}:${v.atMs}`}
                  speakerId={v.speakerId}
                  atMs={v.atMs}
                  names={names}
                  sensitive={sensitive}
                  sessionId={sessionId}
                  range={{ startMs: clip.startMs, endMs: clip.endMs }}
                  language={lang}
                />
              ))}
            </p>
          )}
        </div>
        <p
          role="status"
          className={cn("inline-flex items-center gap-1 text-xs", bad ? "text-red-700" : row.renderOutOfDate ? "font-medium text-stone-900" : "text-muted-foreground")}
        >
          {row.renderOutOfDate && <WarningIcon className="size-3.5" />}
          {status}
        </p>
      </div>

      {clip.failing.length > 0 ? (
        <div className="mt-2 text-[13px]">
          <p className="font-medium">{t("exportScreen.needsAttention")}</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {clip.failing.map((id) =>
              id === "speaker" && clip.unconfirmed.length > 0 ? (
                <li key={id}>{clip.unconfirmed.map((label) => t("prepare.speakerNotConfirmed", { label })).join(" · ")}</li>
              ) : (
                <li key={id}>{t(`prepare.item.${id}`)}</li>
              ),
            )}
          </ul>
          <Link href={`/s/${sessionId}/prepare`} className="mt-1.5 inline-block text-foreground underline underline-offset-2">
            {t("exportScreen.fixInPrepare")}
          </Link>
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-green-800">{t("exportScreen.ready")}</p>
      )}

      <div className="mt-3 border-t border-border pt-3">
        <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("exportScreen.downloads")}</h3>
        {row.mp4 === null && row.languages.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t("exportScreen.noDownloads")}</p>
        ) : (
          <ul className="grid gap-2">
            {row.mp4 !== null && (
              <li className="flex flex-wrap items-center gap-2">
                <span className="w-40 text-[13px] font-medium">{t("exportScreen.video")}</span>
                <a href={row.mp4} aria-label={t("exportScreen.downloadLabel", { what: t("exportScreen.mp4"), title: heading })} className={LINK}>
                  {t("exportScreen.mp4")}
                </a>
              </li>
            )}
            {row.languages.map((l) => (
              <LanguageLine key={l.language} l={l} heading={heading} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function LanguageLine({ l, heading }: { l: ExportLanguageRow; heading: string }) {
  const name = languageLabel(l.language);
  const burnNote = t(`exportScreen.burnStatus.${l.burn.status}`);
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="w-40 text-[13px] font-medium">{t("exportScreen.subtitlesIn", { language: name })}</span>
      {l.srt !== null && (
        <a href={l.srt} aria-label={t("exportScreen.downloadLabel", { what: `${name} ${t("exportScreen.srt")}`, title: heading })} className={LINK}>
          {t("exportScreen.srt")}
        </a>
      )}
      {l.vtt !== null && (
        <a href={l.vtt} aria-label={t("exportScreen.downloadLabel", { what: `${name} ${t("exportScreen.vtt")}`, title: heading })} className={LINK}>
          {t("exportScreen.vtt")}
        </a>
      )}
      {l.outdated && (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-stone-900">
          <WarningIcon className="size-3.5" />
          {t("exportScreen.trackOutdated")}
        </span>
      )}
      {l.burn.url !== null && (
        <a href={l.burn.url} aria-label={t("exportScreen.downloadLabel", { what: `${name} ${t("exportScreen.burned")}`, title: heading })} className={LINK}>
          {t("exportScreen.burned")}
        </a>
      )}
      {burnNote !== "" && (
        <span className={cn("inline-flex items-center gap-1 text-xs", l.burn.status === "failed" ? "text-red-700" : l.burn.outOfDate ? "font-medium text-stone-900" : "text-muted-foreground")}>
          {l.burn.outOfDate && <WarningIcon className="size-3.5" />}
          {t("exportScreen.burned")}: {burnNote}
        </span>
      )}
    </li>
  );
}
