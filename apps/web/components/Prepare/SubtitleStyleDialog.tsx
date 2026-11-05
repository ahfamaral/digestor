"use client";

import { useEffect, useRef, useState } from "react";
import { Noto_Sans } from "next/font/google";
import { SUBTITLE_STYLES, trackToCues, type SubtitlePosition, type SubtitleStyle } from "@digestor/core";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Busy } from "@/components/ui/spinner";
import { pauseAllMedia } from "@/lib/media";
import { t } from "@/lib/i18n";
import { cn } from "cn";
import { previewCss, type SubtitleLook } from "@/lib/subtitlePreview";
import type { ClipView, TrackView } from "@/lib/prepareData";
import { cropPosition } from "./FormatPicker";

// The worker draws subtitles in Noto Sans; the preview loads it too, for this dialog only.
const noto = Noto_Sans({ subsets: ["latin", "latin-ext"], weight: ["400", "700"], display: "swap" });

/** The dark background the render puts behind audio-only clips (`WAVE_BG` in the worker's ffmpeg.ts). */
const AUDIO_BG = "#17181c";

const STYLES: { value: SubtitleStyle; label: string }[] = [
  { value: "yellow", label: t("prepare.styleYellow") },
  { value: "white", label: t("prepare.styleWhite") },
  { value: "white_box", label: t("prepare.styleWhiteBox") },
];
const POSITIONS: { value: SubtitlePosition; label: string }[] = [
  { value: "bottom", label: t("prepare.positionBottom") },
  { value: "above_banner", label: t("prepare.positionAboveBanner") },
  { value: "top", label: t("prepare.positionTop") },
];

export interface SubtitleStyleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clip: ClipView;
  track: TrackView;
  sessionId: string;
  hasVideo: boolean;
  /** The look chosen; throws (with a friendly message) to keep the dialog open. */
  onUse: (look: SubtitleLook) => Promise<void>;
  languageLabel?: string;
}

/**
 * A real frame of the clip (the preview copy, paused at the language's first line) with that line drawn on top in the
 * chosen style and position. Like `ConfirmDialog`: focus starts on Cancel, media pauses on open, Escape cancels.
 */
export function SubtitleStyleDialog(props: SubtitleStyleDialogProps) {
  const { open, onOpenChange } = props;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) pauseAllMedia();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false} initialFocus={cancelRef} className="sm:max-w-xl">
        {/* Remounted per opening, so the choices start from what the clip has now. */}
        {open && <Body {...props} cancelRef={cancelRef} busy={busy} setBusy={setBusy} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  onOpenChange, clip, track, sessionId, hasVideo, onUse, languageLabel, cancelRef, busy, setBusy,
}: SubtitleStyleDialogProps & { cancelRef: React.RefObject<HTMLButtonElement | null>; busy: boolean; setBusy: (b: boolean) => void }) {
  const [look, setLook] = useState<SubtitleLook>({ style: clip.subtitleStyle, position: clip.subtitlePosition });
  const [error, setError] = useState<string | null>(null);
  const [frameH, setFrameH] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameH(el.clientHeight));
    ro.observe(el);
    setFrameH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Cue times are relative to the clip start.
  const first = trackToCues(track.cues)[0];
  const lines = first?.lines ?? [t("prepare.styleSample")];
  const at = clip.startMs + (first?.startMs ?? 0);
  const vertical = clip.format === "9:16";
  const src = `/api/files/${sessionId}/proxy.mp4#t=${(at / 1000).toFixed(2)}`;

  async function use() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUse(look);
      onOpenChange(false);
    } catch (err) {
      console.error("subtitle style: save failed", err);
      setError(err instanceof Error && err.message ? err.message : t("prepare.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("prepare.styleTitle")}</DialogTitle>
        <DialogDescription>{t("prepare.styleMadeAtExport")}</DialogDescription>
      </DialogHeader>
      <div className="grid justify-items-center">
        <div
          ref={frameRef}
          role="img"
          aria-label={t("prepare.styleFrameLabel", { language: languageLabel ?? track.language })}
          className={cn("relative overflow-hidden rounded-lg bg-stone-900", vertical ? "aspect-[9/16] h-[min(55vh,28rem)]" : "aspect-video w-full")}
          style={hasVideo ? undefined : { backgroundColor: AUDIO_BG }}
        >
          {hasVideo && (
            <video
              key={src}
              src={src}
              muted
              preload="metadata"
              playsInline
              tabIndex={-1}
              aria-hidden
              className={cn("absolute inset-0 h-full w-full", vertical ? "object-cover" : "object-contain")}
              style={vertical ? { objectPosition: cropPosition(clip.cropOffset) } : undefined}
            />
          )}
          {frameH > 0 && (
            <div
              lang={track.language}
              dir="auto"
              className={noto.className}
              style={previewCss(look, frameH)}
              data-testid="subtitle-preview"
            >
              {lines.join("\n")}
            </div>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Choice legend={t("prepare.styleLegend")} name="subtitle-style" value={look.style} options={STYLES} onChange={(style) => setLook((l) => ({ ...l, style }))} sample />
        <Choice legend={t("prepare.positionLegend")} name="subtitle-position" value={look.position} options={POSITIONS} onChange={(position) => setLook((l) => ({ ...l, position }))} />
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button ref={cancelRef} type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
          {t("confirm.cancel")}
        </Button>
        <Button type="button" className="bg-brand text-brand-foreground hover:bg-brand/90" disabled={busy} onClick={() => void use()}>
          <Busy busy={busy}>{busy ? t("prepare.styleSaving") : t("prepare.styleUse")}</Busy>
        </Button>
      </DialogFooter>
    </>
  );
}

function Choice<V extends string>({
  legend, name, value, options, onChange, sample,
}: {
  legend: string;
  name: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  sample?: boolean;
}) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-0.5 text-xs font-semibold text-muted-foreground">{legend}</legend>
      {options.map((o) => {
        const st = sample ? SUBTITLE_STYLES[o.value as SubtitleStyle] : null;
        return (
          <label
            key={o.value}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand"
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="accent-[var(--brand)]" />
            {st && (
              <span
                aria-hidden
                className="inline-flex h-6 w-9 items-center justify-center rounded bg-stone-700 text-xs"
                style={{
                  color: st.color,
                  fontWeight: st.bold ? 700 : 400,
                  ...(st.box ? { backgroundColor: "rgba(0,0,0,0.75)" } : { textShadow: "0 0 2px #000, 0 0 2px #000" }),
                }}
              >
                Aa
              </span>
            )}
            <span>{o.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
