import { formatLength, formatMinutes, formatTimestamp, type HighlightTypeId, type MomentWithHighlights, type Topic } from "@digestor/core";
import { HighlightChip } from "@/components/HighlightChip";
import { t } from "@/lib/i18n";

const CARD =
  "flex min-w-0 flex-col items-start gap-1.5 rounded-xl border border-border bg-white p-2.5 text-left hover:border-stone-300 outline-none focus-visible:ring-2 focus-visible:ring-brand";

/** One card per highlight type with its single best moment, plus the most discussed topic. Cards jump to the briefing. */
export function TopHighlights({
  top,
  mostDiscussed,
  language,
  onMoment,
  onTopic,
}: {
  top: { type: HighlightTypeId; moment: MomentWithHighlights }[];
  mostDiscussed: Topic | null;
  language: string | undefined;
  onMoment: (momentId: string) => void;
  onTopic: (topicId: string) => void;
}) {
  if (top.length === 0 && !mostDiscussed) return null;
  return (
    <section aria-label={t("preview.topHighlights")} className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {top.map(({ type, moment }) => {
        const method = moment.highlights.find((h) => h.type === type)?.method ?? "ai";
        return (
          <button key={type} type="button" className={CARD} onClick={() => onMoment(moment.id)}>
            <HighlightChip type={type} method={method} card className="max-w-full" />
            <span lang={language} dir="auto" className="line-clamp-2 text-[13px] leading-snug">
              {moment.title}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatTimestamp(moment.startMs)} · {formatLength(moment.endMs - moment.startMs)}
            </span>
          </button>
        );
      })}
      {mostDiscussed && (
        <button type="button" className={CARD} onClick={() => onTopic(mostDiscussed.id)}>
          <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11.5px] font-semibold text-stone-800">{t("preview.mostDiscussed")}</span>
          <span lang={language} dir="auto" className="line-clamp-2 text-[13px] leading-snug">
            {mostDiscussed.title}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatTimestamp(mostDiscussed.startMs)} · {formatMinutes(mostDiscussed.endMs - mostDiscussed.startMs)}
          </span>
        </button>
      )}
    </section>
  );
}
