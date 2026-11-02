import { HIGHLIGHT_TYPES, formatTimestamp, type HighlightTypeId } from "@digestor/core";
import { TONE_DOT } from "@/components/HighlightChip";
import type { TimelineBand, TimelinePin } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1";

/**
 * The session strip: one neutral band per topic (the topic being read is dark), coloured pins for the top
 * highlights, a time axis and a legend. Long sessions with many topics scroll inside their own box. From `sm` up it
 * stays at the top while the briefing scrolls, so the dark band visibly follows the section being read.
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
  return (
    <section aria-label={t("preview.timeline")} className="mb-4 bg-background py-1 sm:sticky sm:top-0 sm:z-10">
      <div className="overflow-x-auto">
        <div className="px-2 pt-1" style={{ minWidth: `${Math.max(bands.length * 24, 280)}px` }}>
          <div className="flex h-8 overflow-hidden rounded-lg border border-border bg-white">
            {bands.map((b, i) => {
              const active = b.topicId === activeTopicId;
              return (
                <button
                  key={b.topicId}
                  type="button"
                  onClick={() => onBand(b.topicId)}
                  aria-current={active ? "location" : undefined}
                  aria-label={t("preview.timelineBand", { n: i + 1, title: b.title, time: formatTimestamp(b.startMs) })}
                  title={b.title}
                  style={{ width: `${b.widthPct}%` }}
                  className={cn(
                    "min-w-0 truncate border-r-2 border-background px-1.5 text-left text-[11px] last:border-r-0",
                    FOCUS,
                    "focus-visible:ring-inset focus-visible:ring-offset-0",
                    active ? "bg-foreground font-semibold text-white" : "bg-stone-200 text-stone-700 hover:bg-stone-300",
                  )}
                >
                  {b.title}
                </button>
              );
            })}
          </div>
          <div className="relative mt-0.5 h-5">
            {pins.map((p) => (
              <button
                key={`${p.momentId}:${p.type}`}
                type="button"
                onClick={() => onPin(p.momentId)}
                aria-label={t("preview.timelinePin", { type: t(`highlight.${p.type}`), title: p.title, time: formatTimestamp(p.startMs) })}
                title={[t(`highlight.${p.type}`), formatTimestamp(p.startMs), ...(p.people.length > 0 ? [p.people.join(", ")] : [])].join(" · ")}
                style={{ left: `${p.leftPct}%` }}
                className={cn("absolute top-0 grid size-5 -translate-x-1/2 place-items-center rounded-full", FOCUS)}
              >
                <span aria-hidden className={cn("size-3 rounded-full border-2 border-white shadow-[0_0_0_1px_var(--border)]", TONE_DOT[HIGHLIGHT_TYPES[p.type].tone])} />
              </button>
            ))}
          </div>
          <div aria-hidden className="flex justify-between font-mono text-[11px] text-muted-foreground">
            {ticks.map((ms) => (
              <span key={ms}>{formatTimestamp(ms)}</span>
            ))}
          </div>
        </div>
      </div>
      {legend.length > 0 && (
        <ul aria-label={t("preview.legend")} className="mt-1 flex flex-wrap gap-x-3 gap-y-1 px-2 text-[11.5px] text-muted-foreground">
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
