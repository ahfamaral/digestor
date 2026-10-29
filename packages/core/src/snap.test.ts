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
