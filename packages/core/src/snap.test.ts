import { describe, expect, it } from "vitest";
import type { Word } from "./schemas.js";
import { endsSentence, findBoundaries, fitChildInParent, overlapRatio, snapRange } from "./snap.js";

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
  it("includes edges, long pauses and sentence ends (even without a pause)", () => {
    expect(findBoundaries(words, 10_000)).toEqual([
      { afterWordEndMs: 0, beforeWordStartMs: 0 },
      { afterWordEndMs: 900, beforeWordStartMs: 1000 }, // punctuation, 100 ms gap
      { afterWordEndMs: 2000, beforeWordStartMs: 2400 }, // 400 ms pause, no punctuation
      { afterWordEndMs: 3500, beforeWordStartMs: 3600 }, // punctuation
      { afterWordEndMs: 4300, beforeWordStartMs: 10_000 },
    ]);
  });
  it("respects minPauseMs", () => {
    expect(findBoundaries(words, 10_000, 500)).toHaveLength(4);
  });
  it("returns [] for no words", () => {
    expect(findBoundaries([], 1000)).toEqual([]);
  });
});

describe("snapRange", () => {
  const b = findBoundaries(words, 10_000);
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
  it("throws on empty boundaries", () => {
    expect(() => snapRange([], { startMs: 0, endMs: 1 })).toThrow(/boundaries/);
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
