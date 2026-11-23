"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HIGHLIGHT_TYPES, formatTimestamp, type HighlightTypeId } from "@digestor/core";
import { TONE_DOT } from "@/components/HighlightChip";
import { PIN_PX, TRACK_PX, layoutPins, scrollEdges, type TimelineBand, type TimelinePin } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1";

/**
 * The session strip: one neutral band per topic (the last one jumped to is dark), coloured pins for the top
 * highlights (spread for the strip's real width so close ones never pile up; each shows its type and time on hover and
 * keyboard focus), a time axis and a legend. Long sessions with many topics scroll inside their own box, with a fade on
 * the side that has more. A band too narrow for a few letters prints its topic number instead (its name stays in the tooltip and the accessible name).
 */
export function Timeline({
  bands,
  pins,
  durationMs,
  activeTopicId,
  onBand,
  onPin,
}: {
  bands: (TimelineBand & { startMs: number })[];
  pins: (TimelinePin & { title: string; startMs: number; people: string[] })[];
  durationMs: number;
  activeTopicId: string | null;
  onBand: (topicId: string) => void;
  onPin: (momentId: string) => void;
}) {
  const legend = [...new Set(pins.map((p) => p.type))] as HighlightTypeId[];
  const ticks = durationMs > 0 ? [0, durationMs / 2, durationMs] : [0];
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
      setEdges((was) => (was.left === next.left && was.right === next.right ? was : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [bands.length]);
  // Pins are spread for the width the strip really has (a phone's is half the planned one), measured in the browser.
  const track = useRef<HTMLDivElement>(null);
  const [trackPx, setTrackPx] = useState(TRACK_PX);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setTrackPx((was) => (was === w ? was : w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const placed = useMemo(() => layoutPins(pins.map((p) => p.atPct), trackPx), [pins, trackPx]);
  // The band pointed at, focused or picked is named under the strip: a narrow band shows only its number (or nothing).
  const [pointed, setPointed] = useState<number | null>(null);
  const namedIndex = pointed ?? bands.findIndex((b) => b.topicId === activeTopicId);
  const named = namedIndex >= 0 ? bands[namedIndex] : undefined;
  const rows = Math.max(0, ...placed.map((p) => p.row)) + 1;
  return (
    <section aria-label={t("preview.timeline")} className="mt-3">
      <div className="relative">
      <div ref={scroller} className="overflow-x-auto">
        <div className="pt-1" style={{ minWidth: `${Math.max(bands.length * 24, 280)}px` }}>
          <div className="flex h-8 overflow-hidden rounded-lg border border-border bg-white">
            {bands.map((b, i) => {
              const active = b.topicId === activeTopicId;
              return (
                <button
                  key={b.topicId}
                  type="button"
                  onClick={() => onBand(b.topicId)}
                  onMouseEnter={() => setPointed(i)}
                  onMouseLeave={() => setPointed(null)}
                  onFocus={() => setPointed(i)}
                  onBlur={() => setPointed(null)}
                  aria-current={active ? "location" : undefined}
                  aria-label={t("preview.timelineBand", { n: i + 1, title: b.title, time: formatTimestamp(b.startMs) })}
                  title={b.title}
                  style={{ width: `${b.widthPct}%` }}
                  className={cn(
                    // At least 24 px (WCAG 2.5.8): longer bands give up the width.
                    "@container min-w-6 border-r-2 border-background px-0.5 text-left text-[11px] last:border-r-0",
                    FOCUS,
                    "focus-visible:ring-inset focus-visible:ring-offset-0",
                    active ? "bg-foreground font-semibold text-white" : "bg-stone-200 text-stone-700 hover:bg-stone-300",
                  )}
                >
                  <span aria-hidden className="hidden truncate px-1 @min-[3rem]:block">
                    {b.title}
                  </span>
                  {/* Too narrow for the title: the topic's number, the same one its card carries. */}
                  <span aria-hidden className="hidden overflow-hidden text-center text-[10px] tabular-nums @min-[0.75rem]:block @min-[3rem]:hidden">
                    {i + 1}
                  </span>
                </button>
              );
            })}
          </div>
          <p aria-hidden className="mt-1 h-4 truncate text-xs text-muted-foreground">
            {named && t("preview.timelineNamed", { n: namedIndex + 1, title: named.title, time: formatTimestamp(named.startMs) })}
          </p>
          <div ref={track} className="relative mt-0.5" style={{ height: `${rows * PIN_PX}px` }}>
            {pins.map((p, i) => {
              const at = placed[i] ?? { leftPct: p.leftPct, row: p.row };
              const tip = [t(`highlight.${p.type}`), formatTimestamp(p.startMs), ...(p.people.length > 0 ? [p.people.join(", ")] : [])].join(" · ");
              return (
                <button
                  key={`${p.momentId}:${p.type}`}
                  type="button"
                  onClick={() => onPin(p.momentId)}
                  aria-label={t("preview.timelinePin", { type: t(`highlight.${p.type}`), title: p.title, time: formatTimestamp(p.startMs) })}
                  style={{ left: `${at.leftPct}%`, top: `${at.row * PIN_PX}px` }}
                  className={cn("group absolute grid size-6 -translate-x-1/2 place-items-center rounded-full hover:z-20 focus-visible:z-20", FOCUS)}
                >
                  <span aria-hidden className={cn("size-3 rounded-full border-2 border-white shadow-[0_0_0_1px_var(--border)]", TONE_DOT[HIGHLIGHT_TYPES[p.type].tone])} />
                  {/* Visible on hover and on keyboard focus (a title attribute shows on hover only); the button's name says the same. */}
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute bottom-full mb-1 hidden rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white shadow-sm group-hover:block group-focus-visible:block",
                      at.leftPct < 25 ? "left-0" : at.leftPct > 75 ? "right-0" : "left-1/2 -translate-x-1/2",
                    )}
                  >
                    {tip}
                  </span>
                </button>
              );
            })}
          </div>
          <div aria-hidden className="flex justify-between font-mono text-[11px] text-muted-foreground">
            {ticks.map((ms) => (
              <span key={ms}>{formatTimestamp(ms)}</span>
            ))}
          </div>
        </div>
      </div>
      {edges.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-white to-transparent" />}
      {edges.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-white to-transparent" />}
      </div>
      {legend.length > 0 && (
        <ul aria-label={t("preview.legend")} className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
          {legend.map((type) => (
            <li key={type} className="flex items-center gap-1">
              <span aria-hidden className={cn("size-2 rounded-full", TONE_DOT[HIGHLIGHT_TYPES[type].tone])} />
              {t(`highlight.${type}`)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
