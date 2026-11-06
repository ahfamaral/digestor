"use client";

import { useEffect, useRef, useState } from "react";
import { formatTimestamp } from "@digestor/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { patchTrack } from "@/lib/prepareApi";
import type { ClipView, TrackView } from "@/lib/prepareData";
import { pauseAllMedia } from "@/lib/media";
import { cueAt, reviewColumns, seekFor } from "@/lib/subtitlePreview";
import { MediaPlayer } from "@/components/MediaPlayer";
import { cropPosition } from "./FormatPicker";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Busy } from "@/components/ui/spinner";

export interface TrackEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  track: TrackView;
  /** e.g. "German" or "Portuguese (original)". */
  languageLabel: string;
  /** The video's spoken language (the originals are in it). */
  originalLanguage: string | undefined;
  clip: ClipView;
  sessionId: string;
  /** The session has a picture (false: audio only). */
  hasVideo: boolean;
  /** The video was removed (R30): the lines show, without a player, and can't be changed. */
  videoRemoved: boolean;
  /** The clip's poster frame, when there is one. */
  thumbUrl: string | null;
  onSaved: (track: TrackView) => void;
}

/**
 * Review one language's subtitle lines next to the original: edit any line, then approve. Missing lines are marked
 * "Missing translation" and block approval (the server refuses too). Mount it with `key={track.id}` per opening.
 */
export function TrackEditor({
  open, onOpenChange, track, languageLabel, originalLanguage, clip, sessionId, hasVideo, videoRemoved, thumbUrl, onSaved,
}: TrackEditorProps) {
  const [texts, setTexts] = useState(() => track.cues.map((c) => c.text));
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const columns = reviewColumns(track.language, originalLanguage);
  const vertical = clip.format === "9:16";
  const src = `/api/files/${sessionId}/proxy.mp4#t=${(clip.startMs / 1000).toFixed(1)},${(clip.endMs / 1000).toFixed(1)}`;
  const playerLabel = t("prepare.editorPlayerLabel", { language: languageLabel });

  // Other players stop while this one is open; closing the dialog unmounts the player, which pauses it.
  useEffect(() => {
    if (open) pauseAllMedia();
  }, [open]);

  // Keep the playing line in view in the scrolling list.
  useEffect(() => {
    if (active >= 0) document.getElementById(`line-${track.id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, track.id]);

  function seek(i: number) {
    const el = mediaRef.current;
    const cue = track.cues[i];
    if (!el || !cue) return;
    el.currentTime = seekFor(cue, clip);
    setActive(i);
    void el.play().catch(() => {});
  }

  const changed = texts.flatMap((text, i) => (text !== track.cues[i]?.text ? [{ i, text }] : []));
  const missing = texts.filter((x) => x.trim() === "").length;
  const canApprove = !videoRemoved && missing === 0 && texts.length > 0 && (!track.approved || changed.length > 0);

  async function save(): Promise<TrackView | null> {
    if (changed.length === 0) return track;
    const updated = await patchTrack(track.id, { edits: changed });
    onSaved(updated);
    return updated;
  }

  async function run(kind: "save" | "approve") {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await save();
      if (kind === "approve") {
        onSaved(await patchTrack(track.id, { approve: true }));
        onOpenChange(false);
      } else {
        setNotice(t("prepare.linesSaved"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("prepare.saveFailed"));
    }
    setBusy(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("prepare.editorTitle", { language: languageLabel })}</DialogTitle>
          <DialogDescription>{t("prepare.editorDescription")}</DialogDescription>
        </DialogHeader>
        {videoRemoved ? (
          <p className="rounded-lg bg-stone-900 px-4 py-6 text-center text-xs text-stone-300">{t("preview.videoRemoved")}</p>
        ) : (
          <div className="flex shrink-0 justify-center">
            {hasVideo ? (
              <div className={cn("overflow-hidden rounded-lg bg-stone-900", vertical ? "aspect-[9/16] h-[min(30vh,16rem)]" : "aspect-video h-[min(30vh,16rem)]")}>
                <MediaPlayer
                  kind="video"
                  src={src}
                  label={playerLabel}
                  poster={thumbUrl ?? undefined}
                  preload="metadata"
                  mediaRef={mediaRef}
                  onTime={(sec) => setActive(cueAt(track.cues, sec * 1000 - clip.startMs))}
                  className={cn("h-full w-full", vertical ? "object-cover" : "object-contain")}
                  style={vertical ? { objectPosition: cropPosition(clip.cropOffset) } : undefined}
                />
              </div>
            ) : (
              <MediaPlayer
                kind="audio"
                src={src}
                label={playerLabel}
                preload="metadata"
                mediaRef={mediaRef}
                onTime={(sec) => setActive(cueAt(track.cues, sec * 1000 - clip.startMs))}
                className="w-full"
              />
            )}
          </div>
        )}
        {videoRemoved && <p className="text-xs text-muted-foreground">{t("prepare.editorReadOnly")}</p>}
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto border-y border-border px-4 py-2">
          {columns === 2 && (
            <div aria-hidden className="mb-1 hidden grid-cols-2 gap-3 text-xs font-semibold text-muted-foreground sm:grid">
              <span>{t("prepare.colOriginal")}</span>
              <span>{t("prepare.colSubtitle")}</span>
            </div>
          )}
          <ol className="grid gap-2">
            {track.cues.map((cue, i) => {
              const empty = (texts[i] ?? "").trim() === "";
              const id = `cue-${track.id}-${i}`;
              const time = formatTimestamp(cue.startMs, { tenths: true });
              const playing = i === active;
              const canSeek = !videoRemoved;
              const stamp = (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {time}
                  {playing && <span className="sr-only"> {t("prepare.nowPlaying")}</span>}
                </span>
              );
              return (
                <li
                  key={i}
                  id={`line-${track.id}-${i}`}
                  aria-current={playing ? "true" : undefined}
                  className={cn(
                    "grid gap-1 rounded-md border-l-4 pl-2",
                    columns === 2 && "sm:grid-cols-2 sm:gap-3",
                    playing ? "border-brand bg-muted/60" : "border-transparent",
                  )}
                >
                  {columns === 2 ? (
                    <button
                      type="button"
                      disabled={!canSeek}
                      onClick={() => seek(i)}
                      aria-label={canSeek ? t("prepare.playFrom", { time }) : undefined}
                      className="grid content-start justify-items-start gap-0.5 rounded-md text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand enabled:cursor-pointer enabled:hover:bg-muted/60"
                    >
                      {stamp}
                      <span lang={originalLanguage} dir="auto" className="text-foreground/90">
                        <span className="sr-only">{t("prepare.colOriginal")}: </span>
                        {cue.original}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!canSeek}
                      onClick={() => seek(i)}
                      aria-label={canSeek ? t("prepare.playFrom", { time }) : undefined}
                      className="justify-self-start rounded-md px-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand enabled:cursor-pointer enabled:hover:bg-muted/60"
                    >
                      {stamp}
                    </button>
                  )}
                  <div>
                    <label htmlFor={id} className="sr-only">
                      {t("prepare.lineLabel", { n: i + 1, time })}
                    </label>
                    <textarea
                      id={id}
                      lang={track.language}
                      dir="auto"
                      rows={2}
                      value={texts[i] ?? ""}
                      disabled={busy !== null}
                      readOnly={videoRemoved}
                      aria-invalid={empty || undefined}
                      aria-describedby={empty ? `${id}-missing` : undefined}
                      onChange={(e) => setTexts((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
                      className={cn(
                        "w-full resize-y rounded-md border bg-white px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand",
                        empty ? "border-red-400 bg-red-50" : "border-border",
                      )}
                    />
                    {empty && (
                      <p id={`${id}-missing`} className="text-xs font-medium text-red-700">
                        {t("prepare.missing")}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="grid gap-1 text-xs">
          {missing > 0 && <p className="text-red-700">{missing === 1 ? t("prepare.missingOne") : t("prepare.missingMany", { n: missing })}</p>}
          {error && (
            <p role="alert" className="text-red-700">
              {error}
            </p>
          )}
          <p role="status" className="text-muted-foreground">
            {notice}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("prepare.close")}
          </Button>
          <Button type="button" variant="outline" disabled={busy !== null || videoRemoved || changed.length === 0} onClick={() => void run("save")}>
            <Busy busy={busy === "save"}>{busy === "save" ? t("prepare.saving") : t("prepare.saveLines")}</Busy>
          </Button>
          <Button type="button" disabled={busy !== null || !canApprove} onClick={() => void run("approve")}>
            <Busy busy={busy === "approve"}>{busy === "approve" ? t("prepare.approving") : t("prepare.approve")}</Busy>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
