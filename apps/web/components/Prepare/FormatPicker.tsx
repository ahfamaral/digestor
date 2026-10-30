"use client";

import type { ClipFormat } from "@digestor/core";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export interface FormatPickerProps {
  clipId: string;
  format: ClipFormat;
  /** Shown value (follows the slider while it moves). */
  cropOffset: number;
  hasVideo: boolean;
  disabled: boolean;
  onFormat: (format: ClipFormat) => void;
  /** Every slider movement (the preview follows it). */
  onCropInput: (offset: number) => void;
  /** The slider was released or the keyboard paused: save. */
  onCropCommit: () => void;
}

const FORMATS: { id: ClipFormat; hint: "prepare.landscapeHint" | "prepare.verticalHint"; label: "prepare.landscape" | "prepare.vertical" }[] = [
  { id: "16:9", label: "prepare.landscape", hint: "prepare.landscapeHint" },
  { id: "9:16", label: "prepare.vertical", hint: "prepare.verticalHint" },
];

/** CSS `object-position` of the 9:16 preview for a crop offset (−1 left … 1 right). */
export const cropPosition = (offset: number) => `${((offset + 1) * 50).toFixed(1)}% 50%`;

/**
 * 16:9 or 9:16. For 9:16 the clip's player becomes the 9:16 preview box (the proxy cropped with `object-position`),
 * and a −1…1 slider sets the crop offset.
 */
export function FormatPicker({ clipId, format, cropOffset, hasVideo, disabled, onFormat, onCropInput, onCropCommit }: FormatPickerProps) {
  const pct = Math.round((cropOffset + 1) * 50);
  return (
    <section aria-labelledby={`format-h-${clipId}`}>
      <h3 id={`format-h-${clipId}`} className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("prepare.format")}
      </h3>
      <div role="group" aria-labelledby={`format-h-${clipId}`} className="inline-flex rounded-lg border border-border bg-white p-0.5">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={format === f.id}
            disabled={disabled}
            onClick={() => format !== f.id && onFormat(f.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60",
              format === f.id ? "bg-foreground text-white" : "text-foreground hover:bg-muted",
            )}
          >
            {t(f.label)}
            <span className={cn("font-normal", format === f.id ? "text-white/75" : "text-muted-foreground")}>{t(f.hint)}</span>
          </button>
        ))}
      </div>
      {format === "9:16" && hasVideo && (
        <div className="mt-2">
          <label htmlFor={`crop-${clipId}`} className="text-xs font-semibold text-muted-foreground">
            {t("prepare.cropOffset")}
          </label>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span aria-hidden>{t("prepare.cropLeft")}</span>
            <input
              id={`crop-${clipId}`}
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={cropOffset}
              disabled={disabled}
              aria-valuetext={t("prepare.cropValue", { pct })}
              onChange={(e) => onCropInput(Number(e.target.value))}
              onPointerUp={onCropCommit}
              onKeyUp={onCropCommit}
              onBlur={onCropCommit}
              className="h-6 min-w-0 flex-1 accent-brand"
            />
            <span aria-hidden>{t("prepare.cropRight")}</span>
          </div>
        </div>
      )}
      {format === "9:16" && (
        <p className="mt-2 rounded-lg border border-border bg-stone-50 px-2.5 py-1.5 text-xs text-muted-foreground">
          {hasVideo ? t("prepare.verticalNotice") : t("prepare.audioOnlyFormat")}
        </p>
      )}
    </section>
  );
}
