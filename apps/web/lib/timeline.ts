import type { HighlightTypeId, Moment, Topic } from "@digestor/core";

/** The narrowest a topic band may be, so even a 60 s topic in a 5-hour session stays visible and clickable. */
export const MIN_BAND_PCT = 0.5;

export interface TimelineBand {
  topicId: string;
  title: string;
  leftPct: number;
  widthPct: number;
}
export interface TimelinePin {
  momentId: string;
  type: HighlightTypeId;
  leftPct: number;
}

/**
 * Session strip geometry: one band per topic, proportional to its length, each at least `MIN_BAND_PCT` wide and
 * together exactly 100%; one pin per highlight at its moment's start, placed within its topic's band.
 */
export function buildTimeline(
  topics: Pick<Topic, "id" | "title" | "startMs" | "endMs">[],
  highlights: { type: HighlightTypeId; moment: Pick<Moment, "id" | "startMs"> }[],
  durationMs: number,
): { bands: TimelineBand[]; pins: TimelinePin[] } {
  const n = topics.length;
  const raw = topics.map((t) => Math.max(0, t.endMs - t.startMs));
  const total = raw.reduce((a, b) => a + b, 0);
  const min = Math.min(MIN_BAND_PCT, n > 0 ? 100 / n : 0);

  let widths = total > 0 ? raw.map((r) => (r / total) * 100) : raw.map(() => 100 / n);
  // Clamp tiny bands to the minimum and share what's left among the others in proportion; repeat, because the
  // rescale can push another band under the minimum.
  const clamped = new Set<number>();
  for (;;) {
    const under = widths.map((w, i) => (!clamped.has(i) && w < min ? i : -1)).filter((i) => i >= 0);
    if (under.length === 0) break;
    under.forEach((i) => clamped.add(i));
    const freeRaw = raw.reduce((a, r, i) => (clamped.has(i) ? a : a + r), 0);
    const free = 100 - min * clamped.size;
    widths = raw.map((r, i) => (clamped.has(i) ? min : freeRaw > 0 ? (r / freeRaw) * free : 0));
  }
  if (n > 0) widths[n - 1] = 100 - widths.slice(0, -1).reduce((a, b) => a + b, 0);

  let left = 0;
  const bands = topics.map((t, i) => {
    const band = { topicId: t.id, title: t.title, leftPct: left, widthPct: widths[i]! };
    left += widths[i]!;
    return band;
  });
  // A pin sits inside its topic's band (bands may be clamped, and topics may leave gaps); a moment outside every
  // topic falls back to its share of the whole duration.
  const pins = highlights.map((h) => {
    const i = topics.findIndex((t) => h.moment.startMs >= t.startMs && h.moment.startMs < t.endMs);
    let leftPct: number;
    if (i >= 0) {
      const t = topics[i]!;
      const into = Math.min(1, Math.max(0, (h.moment.startMs - t.startMs) / (t.endMs - t.startMs)));
      leftPct = bands[i]!.leftPct + into * bands[i]!.widthPct;
    } else {
      leftPct = durationMs > 0 ? Math.min(100, Math.max(0, (h.moment.startMs / durationMs) * 100)) : 0;
    }
    return { momentId: h.moment.id, type: h.type, leftPct };
  });
  return { bands, pins };
}
