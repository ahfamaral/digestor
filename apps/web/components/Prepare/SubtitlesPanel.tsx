"use client";

import { useState } from "react";
import { LANGUAGES, estimateTranslationUsd } from "@digestor/core";
import { Checkbox } from "@/components/ui/checkbox";
import { WarningIcon } from "@/components/WarningNote";
import { addTrack, patchTrack } from "@/lib/prepareApi";
import { subtitleLanguages, type ClipView, type TrackView } from "@/lib/prepareData";
import { languageName, t } from "@/lib/i18n";
import { aboutUsd } from "@/lib/cost";
import { TrackEditor } from "./TrackEditor";
import { Dropdown } from "@/components/Dropdown";
import { Busy, Spinner } from "@/components/ui/spinner";
import { SubtitleStyleDialog } from "./SubtitleStyleDialog";
import type { SubtitleLook } from "@/lib/subtitlePreview";

export interface SubtitlesPanelProps {
  sessionId: string;
  clipId: string;
  clip: ClipView;
  /** The session has a picture (false: audio only). */
  hasVideo: boolean;
  /** The clip's poster frame, when there is one. */
  thumbUrl: string | null;
  /** Saves the clip's subtitle style and position; resolves false when it failed. */
  onLook: (look: SubtitleLook) => Promise<boolean>;
  /** The video's spoken language, or null when unknown. */
  originalLanguage: string | null;
  tracks: TrackView[];
  /** The video was removed (R30): lines show read-only (no player), and can't be edited, approved or burned any more; adding a language still works. */
  frozen: boolean;
  onTrack: (track: TrackView) => void;
}

const ACT =
  "inline-flex h-7 items-center rounded-md border border-border bg-white px-2 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Subtitles per language: add a language, download drafts, review and approve lines, and ask for a burned-in version.
 * A track built for an older cut is "outdated" (R27): no downloads, and Rebuild replaces it.
 */
export function SubtitlesPanel({ sessionId, clipId, clip, hasVideo, thumbUrl, onLook, originalLanguage, tracks, frozen, onTrack }: SubtitlesPanelProps) {
  const options = subtitleLanguages(originalLanguage, tracks.map((tr) => tr.language));
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackErrors, setTrackErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  /** The style dialog: opened by ticking "put in the video" (then Use also requests it) or by "Change look". */
  const [styling, setStyling] = useState<{ trackId: string; thenBurn: boolean } | null>(null);
  const chosen = options.some((o) => o.code === pick) ? pick : (options[0]?.code ?? "");

  const label = (code: string) => {
    const name = LANGUAGES.find((l) => l.code === code)?.label ?? languageName(code);
    return code === originalLanguage ? t("prepare.original", { language: name }) : name;
  };

  async function add() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      onTrack(await addTrack(clipId, chosen));
      setPick("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy(false);
  }

  /** "Try again" on a failed track and "Rebuild" on an outdated one: the same add, which replaces the old track. */
  async function retry(track: TrackView) {
    setTrackErrors((e) => Object.fromEntries(Object.entries(e).filter(([id]) => id !== track.id)));
    setRetrying(track.id);
    try {
      onTrack(await addTrack(clipId, track.language));
    } catch (err) {
      setTrackErrors((e) => ({ ...e, [track.id]: err instanceof Error ? err.message : t("prepare.saveFailed") }));
    }
    setRetrying(null);
  }

  /** `inline`: the caller (the style dialog) shows the failure itself, so it is rethrown instead of put on the row. */
  async function burn(track: TrackView, want: boolean, inline = false) {
    setTrackErrors((e) => Object.fromEntries(Object.entries(e).filter(([id]) => id !== track.id)));
    try {
      onTrack(await patchTrack(track.id, { burn: want }));
    } catch (err) {
      if (inline) throw err instanceof Error && err.message ? err : new Error(t("prepare.saveFailed"));
      setTrackErrors((e) => ({ ...e, [track.id]: err instanceof Error ? err.message : t("prepare.saveFailed") }));
    }
  }

  const editingTrack = tracks.find((tr) => tr.id === editing) ?? null;
  const stylingTrack = tracks.find((tr) => tr.id === styling?.trackId) ?? null;

  async function saveLook(track: TrackView, look: SubtitleLook, thenBurn: boolean) {
    if (look.style !== clip.subtitleStyle || look.position !== clip.subtitlePosition) {
      if (!(await onLook(look))) throw new Error(t("prepare.saveFailed"));
    }
    if (thenBurn) await burn(track, true, true);
  }

  return (
    <section aria-labelledby={`subs-h-${clipId}`}>
      <h3 id={`subs-h-${clipId}`} className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("prepare.subtitles")}
      </h3>
      {tracks.length === 0 && <p className="mb-2 text-xs text-muted-foreground">{t("prepare.noTracks")}</p>}
      <ul className="grid gap-2">
        {tracks.map((tr) => (
          <TrackRow
            key={tr.id}
            sessionId={sessionId}
            clipId={clipId}
            track={tr}
            label={label(tr.language)}
            frozen={frozen}
            error={trackErrors[tr.id] ?? null}
            onReview={() => setEditing(tr.id)}
            onBurn={(want) => (want ? setStyling({ trackId: tr.id, thenBurn: true }) : void burn(tr, false))}
            onChangeLook={() => setStyling({ trackId: tr.id, thenBurn: false })}
            retrying={retrying === tr.id}
            onRetry={() => void retry(tr)}
          />
        ))}
      </ul>
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 gap-0.5 text-xs font-semibold text-muted-foreground">
            {t("prepare.addLanguage")}
            <Dropdown
              size="sm"
              value={chosen}
              disabled={busy}
              onValueChange={setPick}
              className="w-auto max-w-full min-w-32 font-normal"
              options={options.map((o) => ({
                value: o.code,
                label: o.code === originalLanguage ? t("prepare.original", { language: o.label }) : o.label,
                lang: o.code,
              }))}
            />
          </label>
          <button type="button" className={`${ACT} h-8`} disabled={busy || !chosen} onClick={() => void add()} aria-describedby={chosen ? `${clipId}-sub-cost` : undefined}>
            <Busy busy={busy}>{busy ? t("prepare.adding") : t("prepare.add")}</Busy>
          </button>
          {chosen && (
            <span id={`${clipId}-sub-cost`} className="self-center text-xs text-muted-foreground">
              {chosen === originalLanguage
                ? t("cost.subtitleOriginal")
                : t("cost.subtitleTranslate", { cost: aboutUsd(estimateTranslationUsd(clip.endMs - clip.startMs)) })}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
      {stylingTrack && styling && (
        <SubtitleStyleDialog
          open
          onOpenChange={(open) => !open && setStyling(null)}
          clip={clip}
          track={stylingTrack}
          sessionId={sessionId}
          hasVideo={hasVideo}
          languageLabel={label(stylingTrack.language)}
          onUse={(look) => saveLook(stylingTrack, look, styling.thenBurn)}
        />
      )}
      {editingTrack && (
        <TrackEditor
          key={editingTrack.id}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          track={editingTrack}
          languageLabel={label(editingTrack.language)}
          originalLanguage={originalLanguage ?? undefined}
          clip={clip}
          sessionId={sessionId}
          hasVideo={hasVideo}
          videoRemoved={frozen}
          thumbUrl={thumbUrl}
          onSaved={onTrack}
        />
      )}
    </section>
  );
}

function burnNote(track: TrackView): string | null {
  switch (track.burnStatus) {
    case "stale":
      if (track.burnBuilt) return t("prepare.burnStale");
      return track.approved ? t("prepare.burnRequested") : null;
    case "queued":
    case "rendering":
      return t("prepare.burnMaking");
    case "done":
      return t("prepare.burnDone");
    case "failed":
      return t("prepare.burnFailed");
    default:
      return null;
  }
}

function TrackRow({
  sessionId, clipId, track, label, frozen, error, onReview, onBurn, onChangeLook, retrying, onRetry,
}: {
  sessionId: string;
  clipId: string;
  track: TrackView;
  label: string;
  frozen: boolean;
  error: string | null;
  onReview: () => void;
  onBurn: (want: boolean) => void;
  onChangeLook: () => void;
  retrying: boolean;
  onRetry: () => void;
}) {
  const ready = track.status === "ready";
  const burnOn = track.burnStatus !== "none";
  const making = track.burnStatus === "queued" || track.burnStatus === "rendering";
  // Turning burn-in on needs approved lines; turning a request off is always allowed (except while it's being made).
  const burnDisabled = frozen || !ready || making || (!burnOn && !track.approved);
  const note = burnNote(track);
  const file = (ext: "srt" | "vtt") => `/api/files/${sessionId}/clips/${clipId}.${track.language}.${ext}`;

  return (
    <li className="rounded-lg border border-border bg-white px-2.5 py-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{label}</span>
        {track.status === "preparing" && (
          <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner />
            {t("prepare.preparing")}
          </span>
        )}
        {ready && (
          <span className={track.approved ? "text-xs font-semibold text-green-700" : "text-xs text-muted-foreground"}>
            {track.approved ? t("prepare.approved") : t("prepare.notApproved")}
          </span>
        )}
        {ready && (
          <span className="ml-auto flex items-center gap-1.5">
            {(["srt", "vtt"] as const).map((ext) => (
              <a
                key={ext}
                href={file(ext)}
                download
                aria-label={t("prepare.downloadLabel", { language: label, ext: `.${ext}` })}
                className="rounded px-1 font-mono text-xs underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                .{ext}
              </a>
            ))}
          </span>
        )}
      </div>
      {track.status === "failed" && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p role="alert" className="text-xs text-red-700">
            {track.error ?? t("prepare.trackFailed")}
          </p>
          <button
            type="button"
            className={ACT}
            disabled={retrying}
            onClick={onRetry}
            aria-label={t("prepare.retryLabel", { language: label })}
          >
            <Busy busy={retrying}>{retrying ? t("prepare.adding") : t("prepare.retry")}</Busy>
          </button>
        </div>
      )}
      {track.status === "outdated" && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-stone-900">
            <WarningIcon className="size-3.5" />
            {t("prepare.trackOutdated")}
          </p>
          <button
            type="button"
            className={ACT}
            disabled={retrying || making}
            onClick={onRetry}
            aria-label={t("prepare.rebuildLabel", { language: label })}
          >
            <Busy busy={retrying}>{retrying ? t("prepare.adding") : t("prepare.rebuild")}</Busy>
          </button>
        </div>
      )}
      {ready && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className={ACT} onClick={onReview} aria-label={t("prepare.reviewLabel", { language: label })}>
            {t("prepare.review")}
          </button>
          <label className="flex items-center gap-1.5 text-xs font-medium" title={!track.approved && !burnOn ? t("prepare.burnNeedsApproval") : undefined}>
            <Checkbox
              checked={burnOn}
              disabled={burnDisabled}
              onCheckedChange={(v) => onBurn(v === true)}
              aria-label={t("prepare.burnInLabel", { language: label })}
            />
            <span aria-hidden>{t("prepare.burnIn")}</span>
          </label>
          {burnOn && !frozen && !making && (
            <button
              type="button"
              className="rounded text-xs underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={onChangeLook}
              aria-label={t("prepare.changeLookLabel", { language: label })}
            >
              {t("prepare.changeLook")}
            </button>
          )}
          {!track.approved && <span className="text-xs text-muted-foreground">{t("prepare.burnNeedsApproval")}</span>}
          {note && (
            <span
              className={
                track.burnStatus === "stale" && track.burnBuilt
                  ? "inline-flex items-center gap-1 text-xs font-medium text-stone-900"
                  : "inline-flex items-center text-xs text-muted-foreground"
              }
            >
              {track.burnStatus === "stale" && track.burnBuilt && <WarningIcon className="size-3.5" />}
              <Busy busy={making}>{note}</Busy>
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </li>
  );
}
