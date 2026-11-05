"use client";

import { useState } from "react";
import { formatTimestamp, type TranslatedBriefingContent } from "@digestor/core";
import type { MomentView } from "@/lib/briefingFilters";
import { splitFirstSentence, type PreviewSection } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { MomentRow, type RowContext } from "./MomentRow";

const sentences = (s: { text: string }[]) => s.map((x) => x.text).join(" ").trim();

/**
 * One topic of the Briefing page: numbered title and time range, the topic summary and key quote (collapsed to the
 * first sentence, with "More"), the lane graph (`lanes`, Task 8) and the topic's moments as a tree.
 * `section` is null for the moments outside every topic.
 */
export function TopicCard({
  section,
  translated,
  trLang,
  views,
  ctx,
  lanes,
  emptyNote,
}: {
  section: PreviewSection | null;
  translated: TranslatedBriefingContent | null;
  trLang: string | undefined;
  views: MomentView[];
  ctx: RowContext;
  lanes?: React.ReactNode;
  /** Say that the filters hide this topic's moments (when it has none to show). */
  emptyNote: boolean;
}) {
  const [more, setMore] = useState(false);
  const lang = ctx.language;
  const key = section?.topic.id ?? "outside";
  const trSection = section ? translated?.sections.find((x) => x.topicId === section.topic.id) : undefined;
  const summaryTr = section?.fromBriefing && trSection ? sentences(trSection.summary) : "";
  const quote = section?.keyQuote ?? null;
  const quoteTr = quote && trSection?.keyQuote?.momentId === quote.momentId ? trSection.keyQuote.translation : "";
  const { first, rest } = splitFirstSentence(summaryTr || section?.summary || "");
  const hasMore = rest !== "" || quote !== null;

  return (
    <section
      id={`topic-${key}`}
      data-topic-id={section?.topic.id}
      aria-labelledby={`topic-h-${key}`}
      className="scroll-mt-3 rounded-xl border border-border bg-white px-2 pt-3 pb-2 sm:px-3"
    >
      <div className="px-2">
        <h2 id={`topic-h-${key}`} className="flex flex-wrap items-baseline gap-x-2.5 text-[15px] font-bold">
          {section ? (
            <>
              <span lang={lang} dir="auto">
                {section.n} · {section.topic.title}
              </span>
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {formatTimestamp(section.topic.startMs)} – {formatTimestamp(section.topic.endMs)}
              </span>
            </>
          ) : (
            t("briefing.outsideTopics")
          )}
        </h2>
        {first && (
          <div id={`topic-more-${key}`} className="mt-1 text-sm leading-relaxed">
            <p lang={summaryTr ? trLang : lang} dir="auto" className={cn(!section?.fromBriefing && "text-muted-foreground")}>
              {first}
              {more && rest && <> {rest}</>}
            </p>
            {more && quote && (
              <blockquote className="my-2 border-l-[3px] border-stone-400 bg-stone-50 px-3 py-1.5">
                <p lang={lang} dir="auto" className="italic">
                  “{quote.text}”
                  {quote.startMs !== null && <span className="ml-1.5 font-mono text-xs not-italic text-muted-foreground">— {formatTimestamp(quote.startMs)}</span>}
                </p>
                {quoteTr && (
                  <p lang={trLang} dir="auto" className="mt-1 text-muted-foreground">
                    “{quoteTr}”
                  </p>
                )}
              </blockquote>
            )}
          </div>
        )}
        {first && hasMore && (
          <button
            type="button"
            aria-expanded={more}
            aria-controls={`topic-more-${key}`}
            onClick={() => setMore((o) => !o)}
            className="mt-0.5 rounded-sm text-xs font-medium text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
          >
            {more ? t("briefing.less") : t("briefing.more")}
          </button>
        )}
      </div>

      {/* Task 8: the three-lane graph goes here (hidden below 640 px). */}
      {lanes && <div className="mt-2 px-2">{lanes}</div>}

      {views.length > 0 ? (
        <ul className="mt-2">
          {views.map((v) => (
            <MomentRow key={v.moment.id} view={v} ctx={ctx} />
          ))}
        </ul>
      ) : (
        emptyNote && <p className="mt-2 px-2 pb-1 text-xs text-muted-foreground">{t("briefing.topicEmpty")}</p>
      )}
    </section>
  );
}
