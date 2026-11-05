import { describe, expect, it } from "vitest";
import type { Word } from "./schemas.ts";
import { cutsMidSentence, endsSentence, findBoundaries, fitChildInParent, freeEdges, overlapRatio, snapEdges, snapRange, type Boundary } from "./snap.ts";

const w = (text: string, startMs: number, endMs: number): Word => ({
  text, startMs, endMs, speaker: "A", confidence: 1,
});

// "Hello there." | We think so (400 ms pause) and then stop. | Next one
const words: Word[] = [
  w("Hello", 0, 400), w("there.", 500, 900),
  w("We", 1000, 1200), w("think", 1300, 1600), w("so", 1700, 2000),
  w("and", 2400, 2600), w("then", 2700, 3000), w("stop.", 3100, 3500),
  w("Next", 3600, 4000), w("one", 4100, 4300),
];

describe("endsSentence", () => {
  it("detects sentence-ending punctuation, including trailing closers", () => {
    for (const t of ["there.", "why?", "no!", "so…", "isso。", "ok？", "ok！", 'isso."', "done.)", "x.”"]) {
      expect(endsSentence(t), t).toBe(true);
    }
    for (const t of ["there", "a,", "", '"']) expect(endsSentence(t), t).toBe(false);
  });
});

describe("findBoundaries", () => {
  it("drops a pause when a sentence end is within reach: speakers pause mid-sentence", () => {
    // Seen in the 2026-10-30 smoke run: a 300 ms pause before "que tá aqui nesse mapa" won over the sentence start.
    expect(findBoundaries(words, 10_000)).toEqual([
      { afterWordEndMs: 0, beforeWordStartMs: 0 },
      { afterWordEndMs: 900, beforeWordStartMs: 1000 },
      { afterWordEndMs: 3500, beforeWordStartMs: 3600 },
      { afterWordEndMs: 4300, beforeWordStartMs: 10_000 },
    ]);
    const trimmed = snapRange(findBoundaries(words, 10_000), { startMs: 2_300, endMs: 4_300 });
    expect(trimmed.startMs).toBe(900); // the start of "We think so and then stop.", not "and then stop."
  });
  it("keeps a pause inside a sentence longer than the reach", () => {
    // one sentence of 30 words, 1 s each, with a 500 ms pause after word 15
    const long: Word[] = [];
    for (let i = 0; i < 30; i++) {
      const start = i * 1000 + (i >= 15 ? 500 : 0);
      long.push(w(i === 29 ? "end." : `w${i}`, start, start + 800));
    }
    const bs = findBoundaries(long, 40_000);
    expect(bs.map((b) => b.afterWordEndMs)).toEqual([0, 14_800, 30_300]);
    expect(findBoundaries(long, 40_000, 300, 15_000).map((b) => b.afterWordEndMs)).toEqual([0, 30_300]);
  });
  it("includes edges, long pauses and sentence ends (even without a pause) when the reach is 0", () => {
    expect(findBoundaries(words, 10_000, 300, 0)).toEqual([
      { afterWordEndMs: 0, beforeWordStartMs: 0 },
      { afterWordEndMs: 900, beforeWordStartMs: 1000 }, // punctuation, 100 ms gap
      { afterWordEndMs: 2000, beforeWordStartMs: 2400 }, // 400 ms pause, no punctuation
      { afterWordEndMs: 3500, beforeWordStartMs: 3600 }, // punctuation
      { afterWordEndMs: 4300, beforeWordStartMs: 10_000 },
    ]);
  });
  it("respects minPauseMs", () => {
    expect(findBoundaries(words, 10_000, 500, 0)).toHaveLength(4);
  });
  it("creates no boundary between overlapping words", () => {
    const ov = [w("one.", 0, 900), w("two", 850, 1200), w("three.", 1300, 1600)];
    // "one." ends a sentence but "two" starts before it ends: no boundary there
    expect(findBoundaries(ov, 3000)).toEqual([
      { afterWordEndMs: 0, beforeWordStartMs: 0 },
      { afterWordEndMs: 1600, beforeWordStartMs: 3000 },
    ]);
    const bs = findBoundaries(ov, 3000);
    for (let st = 0; st <= 3000; st += 50) {
      const r = snapRange(bs, { startMs: st, endMs: 3000 - st });
      expect(ov.some((x) => (r.startMs > x.startMs && r.startMs < x.endMs) || (r.endMs > x.startMs && r.endMs < x.endMs))).toBe(false);
    }
  });
  it("returns [] for no words", () => {
    expect(findBoundaries([], 1000)).toEqual([]);
  });
});

describe("snapRange", () => {
  const b = findBoundaries(words, 10_000, 300, 0); // every pause, so these tests reach snapRange's edge cases
  it("never lands mid-word", () => {
    const r = snapRange(b, { startMs: 1_100, endMs: 4_050 });
    expect(words.some((x) => r.startMs > x.startMs && r.startMs < x.endMs)).toBe(false);
    expect(words.some((x) => r.endMs > x.startMs && r.endMs < x.endMs)).toBe(false);
    expect(r).toEqual({ startMs: 900, endMs: 4450 });
  });
  it("pads at most padMs into the gap", () => {
    expect(snapRange(b, { startMs: 2_450, endMs: 3_480 })).toEqual({ startMs: 2250, endMs: 3600 });
  });
  it("moves end to the next boundary when the range collapses", () => {
    const r = snapRange(b, { startMs: 2_400, endMs: 2_100 });
    expect(r.endMs).toBeGreaterThan(r.startMs);
    expect(r).toEqual({ startMs: 2250, endMs: 3600 });
  });
  it("never starts in trailing silence", () => {
    const r = snapRange(b, { startMs: 9_900, endMs: 9_950 });
    expect(r.endMs).toBeGreaterThan(r.startMs);
    expect(words.some((x) => x.startMs >= r.startMs && x.endMs <= r.endMs)).toBe(true);
  });
  it("throws with fewer than 2 boundaries", () => {
    expect(() => snapRange([], { startMs: 0, endMs: 1 })).toThrow(/boundaries/);
    expect(() => snapRange(b.slice(0, 1), { startMs: 0, endMs: 1 })).toThrow(/boundaries/);
  });
  it("sweep: always valid, never mid-word, always contains a word", () => {
    for (let st = 0; st <= 10_000; st += 50) {
      for (let en = 0; en <= 10_000; en += 50) {
        const r = snapRange(b, { startMs: st, endMs: en });
        const msg = `${st}-${en} -> ${r.startMs}-${r.endMs}`;
        expect(r.endMs > r.startMs, msg).toBe(true);
        expect(r.startMs >= 0 && r.endMs <= 10_000, msg).toBe(true);
        expect(words.some((x) => (r.startMs > x.startMs && r.startMs < x.endMs) || (r.endMs > x.startMs && r.endMs < x.endMs)), msg).toBe(false);
        expect(words.some((x) => x.startMs >= r.startMs && x.endMs <= r.endMs), msg).toBe(true);
      }
    }
  });
});

describe("fitChildInParent / overlapRatio", () => {
  it("clamps into parent, null when too short", () => {
    expect(fitChildInParent({ startMs: 0, endMs: 20_000 }, { startMs: 5_000, endMs: 60_000 })).toEqual({ startMs: 5_000, endMs: 20_000 });
    expect(fitChildInParent({ startMs: 0, endMs: 9_000 }, { startMs: 5_000, endMs: 60_000 })).toBeNull();
    expect(fitChildInParent({ startMs: 100_000, endMs: 120_000 }, { startMs: 5_000, endMs: 60_000 })).toBeNull();
  });
  it("computes intersection over shorter length", () => {
    expect(overlapRatio({ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 25 })).toBe(0.5);
    expect(overlapRatio({ startMs: 0, endMs: 10 }, { startMs: 20, endMs: 30 })).toBe(0);
  });
});

describe("free cuts (Alt)", () => {
  const b: Boundary[] = [
    { afterWordEndMs: 1000, beforeWordStartMs: 1400 },
    { afterWordEndMs: 5000, beforeWordStartMs: 5600 },
    { afterWordEndMs: 9000, beforeWordStartMs: 9300 },
  ];
  it("cutsMidSentence is false for snapped cuts and true for an edge in a sentence", () => {
    expect(cutsMidSentence(b, snapRange(b, { startMs: 1200, endMs: 9100 }))).toBe(false);
    expect(cutsMidSentence(b, { startMs: 3000, endMs: 9100 })).toBe(true);
  });
  it("snapEdges keeps an untouched edge verbatim, within tenths precision", () => {
    expect(snapEdges(b, { startMs: 3000, endMs: 9150 }, { startMs: 3000, endMs: 5200 })).toEqual({
      startMs: 3000,
      endMs: snapRange(b, { startMs: 3000, endMs: 5200 }).endMs,
    });
    expect(snapEdges(b, { startMs: 3045, endMs: 9150 }, { startMs: 3000, endMs: 5200 }).startMs).toBe(3045);
    expect(snapEdges(b, { startMs: 12345, endMs: 20000 }, { startMs: 12300, endMs: 20000 }).startMs).toBe(12345);
  });
  it("snapEdges falls back to snapRange when the result would be empty", () => {
    const requested = { startMs: 9200, endMs: 9500 };
    expect(snapEdges(b, { startMs: 9200, endMs: 9800 }, requested)).toEqual(snapRange(b, requested));
  });
  it("a single Alt step is a change, from an on-grid and an off-grid value", () => {
    const end = { startMs: 0, endMs: 30000 };
    for (const [cur, req] of [[12700, 12800], [12700, 12600], [5750, 5850], [5750, 5650]] as const) {
      expect(freeEdges({ startMs: cur, endMs: 30000 }, { startMs: req, endMs: end.endMs }).startMs, `${cur}->${req}`).toBe(req);
    }
    // the unchanged edge sent as tenths (floored) stays untouched
    expect(freeEdges({ startMs: 5750, endMs: 30000 }, { startMs: 5700, endMs: 30000 }).startMs).toBe(5750);
  });
  it("snapEdges snaps a single changed end on its own against a kept free start", () => {
    expect(snapEdges(b, { startMs: 4000, endMs: 9150 }, { startMs: 4000, endMs: 5100 })).toEqual({ startMs: 4000, endMs: 5150 });
  });
  it("freeEdges takes changed edges as given", () => {
    expect(freeEdges({ startMs: 1250, endMs: 9150 }, { startMs: 1250, endMs: 7777 })).toEqual({ startMs: 1250, endMs: 7777 });
    expect(freeEdges({ startMs: 1250, endMs: 9150 }, { startMs: 1200, endMs: 7777 }).startMs).toBe(1250);
  });
});
