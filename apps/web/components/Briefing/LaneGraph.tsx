"use client";

import { formatTimestamp, type Granularity } from "@digestor/core";
import { TONE_DOT } from "@/components/HighlightChip";
import type { LaneBar } from "@/lib/laneBars";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const LANES: Granularity[] = ["exchange", "passage", "punchline"];

/**
 * Three lanes (Exchange / Passage / Punchline) over the topic's time span, one bar per moment the tree shows.
 * Hovering a bar shades its row (and the other way round); clicking scrolls to the row and focuses its Play button.
 * Hidden below 640 px.
 */
export function LaneGraph({
  bars,
  hoveredId,
  onHover,
  onPick,
}: {
  bars: LaneBar[];
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  return (
    <div role="group" aria-label={t("briefing.laneGraph")} className="hidden gap-1 sm:grid">
      {LANES.map((level) => (
        <div key={level} className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
          <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{t(`granularity.${level}`)}</span>
          <div className="relative h-4 rounded-sm bg-stone-100">
            {bars
              .filter((b) => b.level === level)
              .map((b) => (
                <button
                  key={b.id}
                  type="button"
                  aria-label={t("briefing.laneBar", { level: t(`granularity.${level}`), title: b.title, time: formatTimestamp(b.startMs) })}
                  onClick={() => onPick(b.id)}
                  onMouseEnter={() => onHover(b.id)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(b.id)}
                  onBlur={() => onHover(null)}
                  style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
                  className={cn(
                    "absolute inset-y-0.5 min-w-1 rounded-sm opacity-80 outline-none focus-visible:ring-2 focus-visible:ring-brand",
                    b.tone ? TONE_DOT[b.tone] : "bg-stone-300",
                    b.approved && "ring-2 ring-green-600",
                    hoveredId === b.id && "z-10 opacity-100 ring-2 ring-foreground",
                  )}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
