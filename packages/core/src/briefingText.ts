// The briefing as plain Markdown (Preview "Copy text" / "Export…"); client-safe.
import type { BriefingContent, BriefingSentence, Moment, Topic, TranslatedBriefingContent } from "./analysisTypes.ts";
import { formatTimestamp } from "./time.ts";

/** A length in whole minutes, "Nm" (never "0m"). */
export function formatMinutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const joinSentences = (sentences: BriefingSentence[]) => oneLine(sentences.map((s) => s.text).join(" "));

/**
 * The lead, then `## n · <topic> (hh:mm:ss · Nm)` per topic with its summary (the topic's own summary when the
 * briefing has no section for it) and key quote as `> "…" — [hh:mm:ss]`. With a translation, each translated
 * paragraph or quote follows its original, in italics.
 */
export function briefingToMarkdown(a: {
  title: string;
  durationMs: number;
  briefing: BriefingContent | null;
  topics: Pick<Topic, "id" | "title" | "summary" | "startMs" | "endMs">[];
  moments: Pick<Moment, "id" | "startMs">[];
  translation?: TranslatedBriefingContent | null;
}): string {
  const out: string[] = [`# ${oneLine(a.title)}`, formatTimestamp(Math.max(0, a.durationMs))];
  const startOf = new Map(a.moments.map((m) => [m.id, m.startMs]));
  const translated = (text: string) => (text ? `_${text}_` : "");

  const lead = joinSentences(a.briefing?.lead ?? []);
  if (lead) out.push(lead);
  const leadTr = joinSentences(a.translation?.lead ?? []);
  if (lead && leadTr) out.push(translated(leadTr));

  a.topics.forEach((topic, i) => {
    out.push(`## ${i + 1} · ${oneLine(topic.title)} (${formatTimestamp(topic.startMs)} · ${formatMinutes(topic.endMs - topic.startMs)})`);
    const section = a.briefing?.sections.find((s) => s.topicId === topic.id);
    const sectionTr = a.translation?.sections.find((s) => s.topicId === topic.id);
    const summary = section ? joinSentences(section.summary) : oneLine(topic.summary);
    if (summary) out.push(summary);
    const summaryTr = section && sectionTr ? joinSentences(sectionTr.summary) : "";
    if (summary && summaryTr) out.push(translated(summaryTr));

    const quote = section?.keyQuote;
    if (quote) {
      const at = startOf.get(quote.momentId);
      const lines = [`> "${oneLine(quote.text)}"${at === undefined ? "" : ` — [${formatTimestamp(at)}]`}`];
      const quoteTr = sectionTr?.keyQuote?.momentId === quote.momentId ? oneLine(sectionTr.keyQuote.translation) : "";
      if (quoteTr) lines.push(`> _"${quoteTr}"_`);
      out.push(lines.join("\n"));
    }
  });
  return `${out.join("\n\n")}\n`;
}
