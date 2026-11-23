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
  /** Where the moment starts on the strip (0–100), before any spreading. */
  atPct: number;
  /** Pin centre, kept at least half a pin from either end so the first and last pins aren't cut off; moved aside when pins would overlap (`layoutPins`). */
  leftPct: number;
  /** 0-based lane: a pin that would overlap the one before it drops to the next lane. */
  row: number;
}

/** A pin's width, and the track width the spacing is planned for (the strip's real width is only known in the browser). */
export const PIN_PX = 24; // a pin is a 24 px target (WCAG 2.5.8); rows sit 24 px apart
export const TRACK_PX = 560;
export const MAX_PIN_ROWS = 3;

/**
 * Session strip geometry: one band per topic, proportional to its length, each at least `MIN_BAND_PCT` wide and
 * together exactly 100%; one pin per highlight at its moment's start, placed within its topic's band, kept whole inside the track and
 * dropped to a lane of its own when it would overlap a neighbour (`buildTimeline`'s pin placement).
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
  const placed = layoutPins(pins.map((p) => p.leftPct), TRACK_PX);
  return { bands, pins: pins.map((p, i) => ({ ...p, atPct: p.leftPct, ...placed[i]! })) };
}

/**
 * Places pins on a strip `trackPx` wide so none overlaps another and each stays clickable: every pin is kept whole
 * inside the track; a pin closer than one pin width to the last pin of a lane takes the next lane (up to `maxRows`);
 * when every lane is taken there, it goes to the lane with the most room and is moved sideways just enough (and pins
 * crowding an end are pushed back inside). Input positions are 0–100; the result is in the input's order.
 */
export function layoutPins(xs: number[], trackPx: number, pinPx: number = PIN_PX, maxRows: number = MAX_PIN_ROWS): { leftPct: number; row: number }[] {
  const width = Math.max(trackPx, pinPx);
  const half = (pinPx / 2 / width) * 100;
  const gap = (pinPx / width) * 100;
  const clamp = (x: number) => Math.min(100 - half, Math.max(half, Number.isFinite(x) ? x : 0));
  const order = xs.map((x, i) => ({ i, x: clamp(x) })).sort((a, b) => a.x - b.x || a.i - b.i);
  const lanes: { i: number; x: number }[][] = [];
  for (const p of order) {
    let lane = lanes.findIndex((l) => p.x - l.at(-1)!.x >= gap - 1e-9);
    if (lane < 0 && lanes.length < Math.max(1, maxRows)) lane = lanes.push([]) - 1;
    if (lane < 0) {
      // Every lane is taken here: the one whose last pin ends furthest left needs the smallest move.
      lane = lanes.reduce((best, l, k) => (l.at(-1)!.x < lanes[best]!.at(-1)!.x ? k : best), 0);
    }
    const prev = lanes[lane]!.at(-1);
    lanes[lane]!.push({ i: p.i, x: prev ? Math.max(p.x, prev.x + gap) : p.x });
  }
  const out: { leftPct: number; row: number }[] = xs.map(() => ({ leftPct: half, row: 0 }));
  lanes.forEach((lane, row) => {
    const room = Math.floor((100 - 2 * half) / gap + 1e-9) + 1;
    if (lane.length > room) {
      // More pins than fit side by side: share the lane evenly (they touch, but each keeps a slice to click).
      const step = lane.length > 1 ? (100 - 2 * half) / (lane.length - 1) : 0;
      lane.forEach((p, k) => (out[p.i] = { leftPct: half + k * step, row }));
      return;
    }
    // Pushed past the right end: walk back from the end, keeping one pin width between neighbours.
    for (let k = lane.length - 1; k >= 0; k--) {
      const limit = k === lane.length - 1 ? 100 - half : lane[k + 1]!.x - gap;
      if (lane[k]!.x > limit + 1e-9) lane[k]!.x = limit;
    }
    lane.forEach((p) => (out[p.i] = { leftPct: p.x, row }));
  });
  return out;
}

/** Which sides of a sideways-scrolling strip hide more (a pixel of slack for rounding): the fades the strip shows. */
export function scrollEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): { left: boolean; right: boolean } {
  return { left: scrollLeft > 1, right: scrollLeft + clientWidth < scrollWidth - 1 };
}
