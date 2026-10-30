import {
  PROFILES, ProfileIdSchema, topHighlights, type AnalysisVersion, type BriefingContent, type MomentWithHighlights, type ProfileId,
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
  /** The topic's best moment per highlight type (one row per moment), in time order. */
  rows: MomentWithHighlights[];
}

/** The topic a moment belongs to: its `topicId`, else the topic whose span covers its start. */
function topicIdOf(m: MomentWithHighlights, topics: Topic[]): string | null {
  if (m.topicId && topics.some((t) => t.id === m.topicId)) return m.topicId;
  return topics.find((t) => m.startMs >= t.startMs && m.startMs < t.endMs)?.id ?? null;
}

/** Preview sections in topic order: summary, key quote (with its time) and the topic's highlight rows. */
export function buildSections(
  topics: Topic[],
  moments: MomentWithHighlights[],
  briefing: BriefingContent | null,
  profile: ProfileId,
): PreviewSection[] {
  const startOf = new Map(moments.map((m) => [m.id, m.startMs]));
  const byTopic = new Map<string, MomentWithHighlights[]>();
  for (const m of moments) {
    const id = topicIdOf(m, topics);
    if (id) byTopic.set(id, [...(byTopic.get(id) ?? []), m]);
  }
  return topics.map((topic, i) => {
    const section = briefing?.sections.find((s) => s.topicId === topic.id);
    const best = topHighlights(byTopic.get(topic.id) ?? [], profile).map((h) => h.moment);
    const rows = [...new Map(best.map((m) => [m.id, m])).values()].sort((a, b) => a.startMs - b.startMs);
    return {
      n: i + 1,
      topic,
      summary: section ? section.summary.map((s) => s.text).join(" ").trim() : topic.summary,
      fromBriefing: Boolean(section),
      keyQuote: section?.keyQuote ? { ...section.keyQuote, startMs: startOf.get(section.keyQuote.momentId) ?? null } : null,
      rows,
    };
  });
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
