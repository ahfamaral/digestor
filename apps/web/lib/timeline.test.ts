import { describe, expect, it } from "vitest";
import { MIN_BAND_PCT, PIN_PX, TRACK_PX, buildTimeline } from "./timeline";

const topic = (id: string, startMs: number, endMs: number) => ({ id, title: id, startMs, endMs });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("buildTimeline", () => {
  it("buildTimeline widths sum to 100 and tiny topics stay visible", () => {
    const hour = 3_600_000;
    // 5 hours; one 60 s topic would be 0.33% wide without the clamp
    const topics = [topic("a", 0, 2 * hour), topic("b", 2 * hour, 2 * hour + 60_000), topic("c", 2 * hour + 60_000, 5 * hour)];
    const { bands } = buildTimeline(topics, [], 5 * hour);
    expect(bands.map((b) => b.topicId)).toEqual(["a", "b", "c"]);
    expect(sum(bands.map((b) => b.widthPct))).toBeCloseTo(100, 9);
    expect(bands[1]!.widthPct).toBeCloseTo(MIN_BAND_PCT, 9);
    for (const b of bands) expect(b.widthPct).toBeGreaterThanOrEqual(MIN_BAND_PCT - 1e-9);
    // the others shrink in proportion, and bands sit edge to edge
    expect(bands[0]!.widthPct / bands[2]!.widthPct).toBeCloseTo(2 / 2.9833, 3);
    expect(bands[0]!.leftPct).toBe(0);
    expect(bands[1]!.leftPct).toBeCloseTo(bands[0]!.widthPct, 9);
    expect(bands[2]!.leftPct + bands[2]!.widthPct).toBeCloseTo(100, 9);
  });

  it("keeps proportions when nothing is tiny and copes with no or zero-length topics", () => {
    const { bands } = buildTimeline([topic("a", 0, 30_000), topic("b", 30_000, 120_000)], [], 120_000);
    expect(bands.map((b) => b.widthPct)).toEqual([25, 75]);
    expect(buildTimeline([], [], 1000).bands).toEqual([]);
    const zero = buildTimeline([topic("a", 0, 0), topic("b", 0, 0)], [], 0).bands;
    expect(zero.map((b) => b.widthPct)).toEqual([50, 50]);
  });

  it("pins sit at the moment start", () => {
    const { pins } = buildTimeline(
      [topic("a", 0, 600_000)],
      [
        { type: "heated", moment: { id: "m1", startMs: 150_000 } },
        { type: "key_point", moment: { id: "m2", startMs: 0 } },
        { type: "light", moment: { id: "m3", startMs: 900_000 } },
      ],
      600_000,
    );
    const half = (PIN_PX / 2 / TRACK_PX) * 100; // the end pins are pulled in so they stay whole
    expect(pins).toEqual([
      { momentId: "m1", type: "heated", leftPct: 25, row: 0 },
      { momentId: "m2", type: "key_point", leftPct: half, row: 0 },
      { momentId: "m3", type: "light", leftPct: 100 - half, row: 0 },
    ]);
  });

  it("pins sit inside their topic's band, also when bands are clamped or topics leave gaps", () => {
    const hour = 3_600_000;
    // a: 0–2 h, tiny b: 2 h–2 h 1 min (clamped to 0.5%), gap 2 h 1 min–2 h 10 min, c: 2 h 10 min–5 h
    const topics = [topic("a", 0, 2 * hour), topic("b", 2 * hour, 2 * hour + 60_000), topic("c", 2 * hour + 600_000, 5 * hour)];
    const { bands, pins } = buildTimeline(
      topics,
      [
        { type: "heated", moment: { id: "in-tiny", startMs: 2 * hour + 30_000 } },
        { type: "key_point", moment: { id: "mid-c", startMs: 2 * hour + 600_000 + (3 * hour - 600_000) / 2 } },
        { type: "light", moment: { id: "in-gap", startMs: 2 * hour + 300_000 } },
      ],
      5 * hour,
    );
    const [, b, c] = bands;
    // halfway through the clamped band, not at its raw (0.33%-wide) position
    expect(pins[0]!.leftPct).toBeCloseTo(b!.leftPct + b!.widthPct / 2, 9);
    expect(pins[1]!.leftPct).toBeCloseTo(c!.leftPct + c!.widthPct / 2, 9);
    // outside every topic: falls back to start / duration
    expect(pins[2]!.leftPct).toBeCloseTo(((2 * hour + 300_000) / (5 * hour)) * 100, 9);
  });

  it("keeps pins inside the track and spreads pins that would overlap", () => {
    const hour = 3_600_000;
    const halfPct = (PIN_PX / 2 / TRACK_PX) * 100;
    const { pins } = buildTimeline(
      [topic("a", 0, 2 * hour)],
      [
        { type: "heated", moment: { id: "m0", startMs: 0 } },
        { type: "light", moment: { id: "m1", startMs: 1_000 } },
        { type: "key_point", moment: { id: "m2", startMs: 2 * hour - 1 } },
      ],
      2 * hour,
    );
    for (const p of pins) {
      expect(p.leftPct).toBeGreaterThanOrEqual(halfPct - 1e-9);
      expect(p.leftPct).toBeLessThanOrEqual(100 - halfPct + 1e-9);
    }
    const [a, b] = pins;
    const apart = Math.abs(a!.leftPct - b!.leftPct) >= (PIN_PX / TRACK_PX) * 100 - 1e-9;
    expect(apart || a!.row !== b!.row).toBe(true);
    expect(pins[2]!.row).toBe(0);
  });
});

