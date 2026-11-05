import { HIGHLIGHT_TYPES, type Granularity, type Tone } from "@digestor/core";
import type { MomentView } from "./briefingFilters";

export interface LaneBar {
  id: string;
  level: Granularity;
  leftPct: number;
  widthPct: number;
  tone: Tone | null;
  approved: boolean;
}

const MIN_WIDTH_PCT = 0.8;

/** One bar per row the tree shows (children flattened in), placed inside the topic's span and clamped to 0–100. */
export function laneBars(views: MomentView[], topic: { startMs: number; endMs: number }): LaneBar[] {
  const span = Math.max(1, topic.endMs - topic.startMs);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - topic.startMs) / span) * 100));
  const out: LaneBar[] = [];
  const walk = (list: MomentView[]) => {
    for (const v of list) {
      const m = v.moment;
      const left = pct(m.startMs);
      const width = Math.min(Math.max(pct(m.endMs) - left, MIN_WIDTH_PCT), 100);
      const first = m.highlights[0];
      out.push({
        id: m.id, level: m.granularity, leftPct: Math.min(left, 100 - width), widthPct: width,
        tone: first ? HIGHLIGHT_TYPES[first.type].tone : null, approved: v.status === "approved",
      });
      walk(v.children);
    }
  };
  walk(views);
  return out;
}
