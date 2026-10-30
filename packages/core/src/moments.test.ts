import { describe, expect, it } from "vitest";
import type { Word } from "./schemas.ts";
import { insideOf, longestSpeech, speakersIn } from "./moments.ts";

const w = (speaker: string, startMs: number, endMs = startMs + 500): Word => ({ text: "x", startMs, endMs, speaker, confidence: 1 });

describe("longestSpeech", () => {
  it("tolerates gaps under 2 s", () => {
    const words = [w("A", 0), w("A", 1500), w("A", 3000), w("B", 3600), w("A", 4200), w("A", 8000), w("A", 9000)];
    // A: 0-3500 (gaps 1 s) is cut by B; 8000-9500 is its own run
    expect(longestSpeech(words)).toEqual({ speaker: "A", startMs: 0, endMs: 3500 });
    const gap = [w("A", 0), w("A", 1900), w("A", 3800), w("A", 6500)];
    expect(longestSpeech(gap)).toEqual({ speaker: "A", startMs: 0, endMs: 4300 });
    expect(longestSpeech([])).toBeNull();
  });
});

describe("speakersIn", () => {
  it("applies the 10% share", () => {
    const words = [...Array.from({ length: 9 }, (_, i) => w("A", i * 100)), w("B", 900), ...Array.from({ length: 80 }, (_, i) => w("C", 1000 + i * 100))];
    expect(speakersIn(words, { startMs: 0, endMs: 1000 })).toEqual(["A", "B"]);
    expect(speakersIn(words, { startMs: 0, endMs: 9000 })).toEqual(["C", "A"]);
    expect(speakersIn(words, { startMs: 50_000, endMs: 60_000 })).toEqual([]);
  });
});

describe("insideOf", () => {
  it("picks the containing parent", () => {
    const parents = [
      { startMs: 0, endMs: 100 },
      { startMs: 150, endMs: 400 },
      { startMs: 100, endMs: 1000 },
    ];
    expect(insideOf({ startMs: 200, endMs: 300 }, parents)).toBe(1);
    expect(insideOf({ startMs: 90, endMs: 120 }, parents)).toBeNull();
    expect(insideOf({ startMs: 500, endMs: 600 }, parents)).toBe(2);
  });
});
