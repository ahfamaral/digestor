import { formatLength, formatTimestamp, type HighlightTypeId, type MomentWithHighlights } from "@digestor/core";
import { HighlightChip, MethodBadge } from "@/components/HighlightChip";
import { groupTopHighlights, type mostDiscussedCard } from "@/lib/preview";
import { labelText, voiceLabel, type NamesData, type Voice } from "@/lib/names";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const CARD =
  "flex min-w-0 flex-col items-start gap-1.5 rounded-xl border border-border bg-white p-2.5 text-left hover:border-stone-300 outline-none focus-visible:ring-2 focus-visible:ring-brand";

/**
 * One card per moment that tops a highlight type (a moment that tops several carries every chip, in type order), plus the
 * most discussed topic. Cards jump to the moment's row or the topic's card.
 */
export function TopHighlights({
  top,
  names,
  voices,
  sensitive,
  mostDiscussed,
  language,
  onMoment,
  onTopic,
}: {
  top: { type: HighlightTypeId; moment: MomentWithHighlights }[];
  names: NamesData;
  voices: Record<string, Voice[]>;
  sensitive: boolean;
  mostDiscussed: ReturnType<typeof mostDiscussedCard>;
  language: string | undefined;
  onMoment: (momentId: string) => void;
  onTopic: (topicId: string) => void;
}) {
  if (top.length === 0 && !mostDiscussed) return null;
  return (
    <section aria-label={t("preview.topHighlights")} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {groupTopHighlights(top).map(({ moment, types }) => {
        return (
          <button key={moment.id} type="button" className={CARD} onClick={() => onMoment(moment.id)}>
            <span className="flex max-w-full flex-wrap gap-1">
              {types.map(({ type, method }) => (
                <HighlightChip key={type} type={type} method={method} card className="max-w-full text-left whitespace-normal" />
              ))}
            </span>
            <span lang={language} dir="auto" className="line-clamp-2 text-[13px] leading-snug">
              {moment.title}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatTimestamp(moment.startMs)} · {formatLength(moment.endMs - moment.startMs)}
            </span>
            {(voices[moment.id] ?? []).length > 0 && (
              <span className="line-clamp-2 text-[11.5px] text-muted-foreground">
                <span className="sr-only">{t("briefing.speakers")}: </span>
                {(voices[moment.id] ?? []).map((v, i) => {
                  const label = voiceLabel(names, v.speakerId, v.atMs, sensitive);
                  return (
                    <span key={`${v.speakerId}:${v.atMs}`}>
                      {i > 0 && ", "}
                      <span dir="auto" className={cn(label.proposed && "underline decoration-dotted underline-offset-2")}>
                        {labelText(label)}
                      </span>
                    </span>
                  );
                })}
              </span>
            )}
          </button>
        );
      })}
      {mostDiscussed && (
        <button type="button" className={CARD} onClick={() => onTopic(mostDiscussed.topicId)}>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-200 px-2 py-0.5 text-[11.5px] font-semibold text-stone-800">
            {t("preview.mostDiscussed")}
            <MethodBadge method={mostDiscussed.method} />
          </span>
          <span lang={language} dir="auto" className="line-clamp-2 text-[13px] leading-snug">
            {mostDiscussed.title}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatTimestamp(mostDiscussed.startMs)} · {mostDiscussed.detail}
          </span>
        </button>
      )}
    </section>
  );
}
