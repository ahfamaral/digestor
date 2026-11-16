import {
  PROFILES, ProfileIdSchema, formatMinutes, mostDiscussedTopic, type HighlightMethod, type HighlightTypeId, type AnalysisVersion, type BriefingContent, type MomentWithHighlights, type ProfileId,
  type Topic,
} from "@digestor/core";
import { t } from "./i18n";

export interface PreviewSection {
  /** 1-based position, as shown ("2 · Public transport"). */
  n: number;
  topic: Topic;
  /** The briefing's summary for the topic, or the topic's own summary when the briefing has no section for it. */
  summary: string;
  fromBriefing: boolean;
  keyQuote: { momentId: string; text: string; startMs: number | null } | null;
}

/** The topic a moment belongs to: its `topicId`, else the topic whose span covers its start. */
export function topicIdOf(m: MomentWithHighlights, topics: Topic[]): string | null {
  if (m.topicId && topics.some((t) => t.id === m.topicId)) return m.topicId;
  return topics.find((t) => m.startMs >= t.startMs && m.startMs < t.endMs)?.id ?? null;
}

/** The topic header of each Briefing card, in topic order: summary and key quote (with its time). */
export function buildSections(topics: Topic[], moments: MomentWithHighlights[], briefing: BriefingContent | null): PreviewSection[] {
  const startOf = new Map(moments.map((m) => [m.id, m.startMs]));
  return topics.map((topic, i) => {
    const section = briefing?.sections.find((s) => s.topicId === topic.id);
    return {
      n: i + 1,
      topic,
      summary: section ? section.summary.map((s) => s.text).join(" ").trim() : topic.summary,
      fromBriefing: Boolean(section),
      keyQuote: section?.keyQuote ? { ...section.keyQuote, startMs: startOf.get(section.keyQuote.momentId) ?? null } : null,
    };
  });
}

/**
 * Text split after its first sentence (for "More"): a sentence ends at . ! ? … or their CJK/Arabic forms followed by
 * a space (or, for CJK full stops, directly). `rest` is "" when there is nothing more.
 */
export function splitFirstSentence(text: string): { first: string; rest: string } {
  const s = text.trim();
  const m = /^([\s\S]+?(?:[.!?…؟](?=\s)|[。！？]))\s*(\S[\s\S]*)$/u.exec(s);
  return m ? { first: m[1]!, rest: m[2]! } : { first: s, rest: "" };
}

/** A stored profile id as a known profile (older rows or bad data fall back to "other"). */
export const asProfile = (id: string | null | undefined): ProfileId => {
  const parsed = ProfileIdSchema.safeParse(id);
  return parsed.success ? parsed.data : "other";
};

/** Why the current analysis is a re-run, for the "Analysis v<n>" tooltip; null for the first version. */
export function versionNote(versions: Pick<AnalysisVersion, "id" | "version" | "profile" | "reason">[], currentId: string): string | null {
  const current = versions.find((v) => v.id === currentId);
  if (!current || current.version <= 1) return null;
  const previous = versions.filter((v) => v.version < current.version).sort((a, b) => b.version - a.version)[0];
  if (previous && previous.profile !== current.profile) {
    return t("preview.rerunProfile", { profile: PROFILES[asProfile(current.profile)].label });
  }
  return t("preview.rerunReason", { reason: current.reason });
}

/** The "Most discussed" card: the topic with the most speaking time. It is counted, not judged (Ruling R21). */
export function mostDiscussedCard(
  topics: Topic[],
): { topicId: string; title: string; startMs: number; method: HighlightMethod; detail: string } | null {
  const topic = mostDiscussedTopic(topics);
  if (!topic) return null;
  return {
    topicId: topic.id,
    title: topic.title,
    startMs: topic.startMs,
    method: "counted",
    detail: t("preview.mostDiscussedDetail", { length: formatMinutes(topic.endMs - topic.startMs) }),
  };
}

/**
 * The number of the newest analysis version when it is newer than the shown one and failed; otherwise null (no
 * re-run, one still running, or a newer one succeeded and is now shown). A failed re-run must never just vanish.
 */
export function latestFailedAfter(versions: Pick<AnalysisVersion, "id" | "version" | "status">[], currentId: string): number | null {
  const current = versions.find((v) => v.id === currentId);
  const latest = versions.reduce<(typeof versions)[number] | null>((a, v) => (!a || v.version > a.version ? v : a), null);
  if (!current || !latest || latest.version <= current.version || latest.status !== "failed") return null;
  return latest.version;
}

export interface TopHighlightCard {
  moment: MomentWithHighlights;
  /** Every type this moment tops, in the profile's type order, each with its method (AI or counted). */
  types: { type: HighlightTypeId; method: HighlightMethod }[];
}

/**
 * The top-highlight cards: one per moment, so a moment that tops several types ("News line", "Dodged the question",
 * "Key point") is one card carrying every chip, never the same moment twice. Cards keep the order of their first type.
 */
export function groupTopHighlights(top: { type: HighlightTypeId; moment: MomentWithHighlights }[]): TopHighlightCard[] {
  const cards: TopHighlightCard[] = [];
  const byMoment = new Map<string, TopHighlightCard>();
  for (const { type, moment } of top) {
    const method = moment.highlights.find((h) => h.type === type)?.method ?? "ai";
    const card = byMoment.get(moment.id);
    if (card) {
      card.types.push({ type, method });
      continue;
    }
    const next = { moment, types: [{ type, method }] };
    byMoment.set(moment.id, next);
    cards.push(next);
  }
  return cards;
}
