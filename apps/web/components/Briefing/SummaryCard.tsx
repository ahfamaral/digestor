"use client";

import { useMemo } from "react";
import { topHighlights, type BriefingContent, type MomentWithHighlights, type ProfileId, type Topic } from "@digestor/core";
import type { NamesData, Voice } from "@/lib/names";
import { labelText, voiceLabel } from "@/lib/names";
import { mostDiscussedCard } from "@/lib/preview";
import { buildTimeline } from "@/lib/timeline";
import type { BriefingTranslation } from "@/lib/useBriefingTranslation";
import { t } from "@/lib/i18n";
import { Timeline } from "./Timeline";
import { TopHighlights } from "./TopHighlights";

const sentences = (s: { text: string }[]) => s.map((x) => x.text).join(" ").trim();

/**
 * The top of the Briefing page: the lead paragraph (translated when "Read in" is set), the session timeline, the
 * top-highlight cards and, at the bottom, the document actions and "Something's off" (`actions`).
 */
export function SummaryCard({
  durationMs,
  language,
  profile,
  briefing,
  topics,
  moments,
  names,
  voices,
  sensitive,
  tr,
  activeTopicId,
  onMoment,
  onTopic,
  actions,
}: {
  durationMs: number;
  language: string | undefined;
  profile: ProfileId;
  briefing: BriefingContent | null;
  topics: Topic[];
  /** The analysis's own moments (the timeline and top highlights never pick personal ones). */
  moments: MomentWithHighlights[];
  names: NamesData;
  voices: Record<string, Voice[]>;
  sensitive: boolean;
  tr: BriefingTranslation;
  activeTopicId: string | null;
  onMoment: (momentId: string) => void;
  onTopic: (topicId: string) => void;
  actions: React.ReactNode;
}) {
  const top = useMemo(() => topHighlights(moments, profile), [moments, profile]);
  const mostDiscussed = useMemo(() => mostDiscussedCard(topics), [topics]);
  const timeline = useMemo(() => {
    const { bands, pins } = buildTimeline(topics, top, durationMs);
    const byId = new Map(moments.map((m) => [m.id, m]));
    const startOf = new Map(topics.map((tp) => [tp.id, tp.startMs]));
    return {
      bands: bands.map((b) => ({ ...b, startMs: startOf.get(b.topicId) ?? 0 })),
      pins: pins.map((p) => ({
        ...p,
        title: byId.get(p.momentId)?.title ?? "",
        startMs: byId.get(p.momentId)?.startMs ?? 0,
        people: (voices[p.momentId] ?? []).map((v) => labelText(voiceLabel(names, v.speakerId, v.atMs, sensitive))),
      })),
    };
  }, [topics, top, moments, durationMs, voices, names, sensitive]);

  const lead = briefing ? sentences(briefing.lead) : "";
  const leadTr = tr.translated ? sentences(tr.translated.lead) : "";

  return (
    <section aria-labelledby="summary-heading" className="mb-4 rounded-xl border border-border bg-white px-4 py-4 sm:px-5">
      <h2 id="summary-heading" className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
        {t("briefing.summary")}
      </h2>
      {lead && (
        <p lang={leadTr ? tr.lang : language} dir="auto" className="mt-2 text-[15px] leading-relaxed">
          {leadTr || lead}
        </p>
      )}
      {!briefing && <p className="mt-2 text-sm text-muted-foreground">{t("preview.noBriefing")}</p>}
      <Timeline
        bands={timeline.bands}
        pins={timeline.pins}
        durationMs={durationMs}
        activeTopicId={activeTopicId}
        onBand={onTopic}
        onPin={onMoment}
      />
      <TopHighlights top={top} names={names} voices={voices} sensitive={sensitive} mostDiscussed={mostDiscussed} language={language} onMoment={onMoment} onTopic={onTopic} />
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">{actions}</div>
    </section>
  );
}
