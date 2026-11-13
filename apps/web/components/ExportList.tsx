"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatLength, formatTimestamp, type ChecklistId } from "@digestor/core";
import { SpeakerName, SpeakerSep } from "@/components/Names/SpeakerName";
import type { NamesData, Voice, WhosWhoRow } from "@/lib/names";
import { UnconfirmedBanner } from "@/components/Names/UnconfirmedBanner";
import { AppBar } from "@/components/AppBar";
import { BackLink } from "@/components/BackLink";
import { MediaPlayer } from "@/components/MediaPlayer";
import { WarningIcon } from "@/components/WarningNote";
import { ApprovalDismissed } from "@/components/ApprovalDismissed";
import { exportStatus, exportableIds, inFlight, languageLabel, renderedFirst, sortByOrder, statusLabel, toMake, type ExportLanguageRow, type ExportRow } from "@/lib/exportRows";
import { t } from "@/lib/i18n";
import { startRefreshLoop } from "@/lib/refreshLoop";
import { cn } from "@/lib/utils";
import { Busy } from "@/components/ui/spinner";
import { DownloadAllDialog } from "@/components/Export/DownloadAllDialog";
import { HasVideoProvider } from "@/components/HasVideo";

export const EXPORT_POLL_MS = 3000;

export interface ExportClipData {
  id: string;
  /** The clip's moment title (in the spoken language). */
  title: string;
  startMs: number;
  endMs: number;
  /** Checklist items that don't hold yet. Empty = ready to export. */
  failing: ChecklistId[];
  /** The clip's moment is no longer approved on the Briefing: shown with a label, left out of Export ready clips. */
  dismissed: boolean;
  /** Who speaks in the clip (longest first). */
  voices: Voice[];
  row: ExportRow;
}

export interface ExportListProps {
  session: { id: string; title: string; language: string | null; videoRemoved: boolean; sensitive: boolean; hasVideo: boolean };
  names: NamesData;
  /** Who's who rows of the whole session, and the voices that block clips (the banner). */
  whoRows: WhosWhoRow[];
  unconfirmed: { voices: number; clips: number; blocking: Record<string, number> };
  profile: string;
  clips: ExportClipData[];
}

const LINK =
  "inline-flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-semibold outline-none hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-brand";
const NOTICE = "mb-3 rounded-lg border px-3 py-2 text-sm";

/** Export: each prepared clip with its checklist, the Export button, and every download (MP4, SRT/VTT, MP4 with subtitles). */
export function ExportList({ session, names, whoRows, unconfirmed, profile, clips }: ExportListProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  // Rendered clips first, sorted once on load: the order stays put while renders finish.
  const [order] = useState(() => renderedFirst(clips.map((c) => ({ id: c.id, row: c.row }))).map((c) => c.id));
  // Only errors and one-off answers are click-set; "rendering has started" is derived from live statuses.
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const lang = session.language ?? undefined;
  const readyIds = exportableIds(clips);
  const ready = clips.filter((c) => readyIds.includes(c.id));
  const polling = inFlight(clips.map((c) => c.row));
  const missing = toMake(ready.map((c) => c.row));

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
        body: JSON.stringify({ clipIds: readyIds }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; queued?: number; burns?: number; blocked?: unknown[] };
      if (!res.ok) {
        setMessage({ kind: "error", text: data.error ?? t("exportScreen.failed") });
      } else if ((data.queued ?? 0) + (data.burns ?? 0) === 0) {
        setMessage({ kind: "ok", text: t("exportScreen.nothingNew") });
      } else {
        // The "started" banner is derived from the statuses after the refresh; only the blocked note is click-set.
        setMessage((data.blocked ?? []).length > 0 ? { kind: "ok", text: t("exportScreen.blockedSome") } : null);
      }
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: t("exportScreen.failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <HasVideoProvider value={session.hasVideo}>
      <AppBar
        current="Export"
        session={{ id: session.id, ready: true }}
        facts={{ hasClips: clips.length > 0, allReadyRendered: ready.length > 0 && ready.every((c) => c.row.renderStatus === "done") }}
      />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 sm:px-6">
        <header className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <BackLink href={`/s/${session.id}/prepare`} label={t("exportScreen.backToPrepare")} />
            <h1 lang={lang} dir="auto" className="mt-1 text-xl font-bold tracking-tight break-words">
              {session.title}
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {t("exportScreen.title")} · {clips.length === 1 ? t("exportScreen.clipsOne") : t("exportScreen.clipsMany", { n: clips.length })}
            </p>
          </div>
          <DownloadAllDialog sessionId={session.id} clips={clips} language={lang} />
        </header>

        <UnconfirmedBanner
          sessionId={session.id}
          unconfirmed={unconfirmed}
          rows={whoRows}
          names={names}
          sensitive={session.sensitive}
          profile={profile}
          language={lang}
          videoRemoved={session.videoRemoved}
        />

        {session.videoRemoved && (
          <p id="video-removed" role="status" className={`${NOTICE} border-border bg-stone-100 text-stone-800`}>
            {t("preview.videoRemoved")}
          </p>
        )}
        {polling && (
          <p role="status" className={`${NOTICE} border-green-200 bg-green-50 text-green-900`}>
            {t("exportScreen.started")}
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

        <p className="mb-3 text-xs text-muted-foreground">{t("exportScreen.explainer")}</p>

        {clips.length === 0 ? (
          <div className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">
            <p>{t("exportScreen.noClips")}</p>
            <Link href={`/s/${session.id}`} className="mt-2 inline-block text-foreground underline underline-offset-2">
              {t("exportScreen.openBriefing")}
            </Link>
          </div>
        ) : (
          <ol className="grid gap-3">
            {sortByOrder(clips.map((clip, i) => ({ clip, n: i + 1, id: clip.id })), order).map(({ clip, n }) => (
              <ClipRow key={clip.id} n={n} clip={clip} sessionId={session.id} lang={lang} names={names} sensitive={session.sensitive} watching={watching} setWatching={setWatching} />
            ))}
          </ol>
        )}

        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">{t("exportScreen.notice")}</p>

        <footer className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <span className="text-sm font-medium text-muted-foreground">{missing === 0
                ? t("exportScreen.readyCount", { n: ready.length, total: clips.length })
                : missing === 1
                  ? t("exportScreen.readyCountToMakeOne", { n: ready.length, total: clips.length })
                  : t("exportScreen.readyCountToMake", { n: ready.length, total: clips.length, m: missing })}</span>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy || session.videoRemoved || ready.length === 0}
              aria-describedby={session.videoRemoved ? "video-removed" : undefined}
              className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground"
            >
              <Busy busy={busy}>{busy ? t("exportScreen.exporting") : t("exportScreen.exportReady")}</Busy>
            </button>
          </div>
        </footer>
      </main>
    </HasVideoProvider>
  );
}

function ClipRow({
  n, clip, sessionId, lang, names, sensitive, watching, setWatching,
}: {
  n: number;
  clip: ExportClipData;
  sessionId: string;
  lang: string | undefined;
  names: NamesData;
  sensitive: boolean;
  watching: string | null;
  setWatching: (key: string | null) => void;
}) {
  const { row } = clip;
  const heading = clip.title || t("exportScreen.clipHeading", { n });
  const state = exportStatus(clip);
  const status = statusLabel(state);
  const bad = state.kind === "failed";
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
          {clip.dismissed && (
            <p className="mt-1">
              <ApprovalDismissed id={`dismissed-${clip.id}`} />
            </p>
          )}
          {clip.voices.length > 0 && (
            <p className="mt-0.5 flex flex-wrap items-center text-xs text-muted-foreground">
              <span className="sr-only">{t("briefing.speakers")}: </span>
              {clip.voices.map((v, i) => (
                <Fragment key={`${v.speakerId}:${v.atMs}`}>
                  {i > 0 && <SpeakerSep />}
                  <SpeakerName
                    speakerId={v.speakerId}
                    atMs={v.atMs}
                    names={names}
                    sensitive={sensitive}
                    sessionId={sessionId}
                    range={{ startMs: clip.startMs, endMs: clip.endMs }}
                    language={lang}
                  />
                </Fragment>
              ))}
            </p>
          )}
        </div>
        <p
          role="status"
          className={cn("inline-flex items-center gap-1 text-xs", bad ? "text-red-700" : state.kind === "stale" ? "font-medium text-stone-900" : state.kind === "rendered" ? "font-medium text-green-800" : "text-muted-foreground")}
        >
          {state.kind === "stale" && <WarningIcon className="size-3.5" />}
          <Busy busy={state.kind === "rendering"}>{status}</Busy>
        </p>
      </div>

      {state.kind === "needs" ? (
        <p className="mt-2 text-[13px]">
          <Link href={`/s/${sessionId}/prepare#clip-${clip.id}`} className="text-foreground underline underline-offset-2">
            {t("exportScreen.fixInPrepare")}
          </Link>
        </p>
      ) : state.kind === "dismissed" ? (
        <p className="mt-2 text-[13px] text-stone-700">{t("prepare.approvalDismissedHint")}</p>
      ) : null}

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
                <WatchToggle
                  id={`${clip.id}:mp4`}
                  what={t("exportScreen.mp4")}
                  title={heading}
                  src={row.watch.mp4}
                  tracks={row.watch.tracks}
                  watching={watching}
                  setWatching={setWatching}
                />
              </li>
            )}
            {row.languages.map((l) => (
              <LanguageLine key={l.language} l={l} heading={heading} id={`${clip.id}:${l.language}:burned`} watchSrc={row.watch.burned.find((b) => b.language === l.language)?.src ?? null} watching={watching} setWatching={setWatching} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** "▶ Watch" toggle for a rendered file; the player opens full width under its row (the parent `li` wraps). */
function WatchToggle({
  id, what, title, src, tracks, watching, setWatching,
}: {
  id: string;
  what: string;
  title: string;
  src: string | null;
  tracks?: { src: string; srcLang: string; label: string }[];
  watching: string | null;
  setWatching: (key: string | null) => void;
}) {
  if (src === null) return null;
  const open = watching === id;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`player-${id.replaceAll(":", "-")}`}
        aria-label={t("exportScreen.watchLabel", { what, title })}
        onClick={() => setWatching(open ? null : id)}
        className={LINK}
      >
        {open ? t("exportScreen.watchHide") : t("exportScreen.watch")}
      </button>
      {open && (
        <div id={`player-${id.replaceAll(":", "-")}`} className="basis-full">
          <MediaPlayer
            kind="video"
            src={src}
            label={t("exportScreen.playerLabel", { what, title })}
            tracks={tracks}
            autoPlay
            className="max-h-[70vh] w-full max-w-xl rounded-lg bg-black"
          />
        </div>
      )}
    </>
  );
}

function LanguageLine({
  l, heading, id, watching, setWatching, watchSrc,
}: {
  l: ExportLanguageRow;
  heading: string;
  id: string;
  watching: string | null;
  setWatching: (key: string | null) => void;
  watchSrc: string | null;
}) {
  const name = languageLabel(l.language);
  const state = l.burn.state;
  const burnNote = state === "none" || state === "done" ? "" : t(`exportScreen.burnState.${state}`);
  const burnLabel = t("exportScreen.burned", { language: name });
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
        <a href={l.burn.url} aria-label={t("exportScreen.downloadLabel", { what: burnLabel, title: heading })} className={LINK}>
          {burnLabel}
        </a>
      )}
      <WatchToggle id={id} what={burnLabel} title={heading} src={watchSrc} watching={watching} setWatching={setWatching} />
      {burnNote !== "" && (
        <span className={cn("inline-flex items-center gap-1 text-xs", state === "failed" ? "text-red-700" : state === "outOfDate" ? "font-medium text-stone-900" : "text-muted-foreground")}>
          {state === "outOfDate" && <WarningIcon className="size-3.5" />}
          <Busy busy={state === "making"}>
            {burnLabel}: {burnNote}
          </Busy>
        </span>
      )}
    </li>
  );
}
