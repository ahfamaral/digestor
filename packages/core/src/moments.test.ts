import { describe, expect, it } from "vitest";
import type { Word } from "./schemas.ts";
import { insideOf, longestSpeech, mostDiscussedTopic, speakersIn, topHighlights, topicForStart } from "./moments.ts";
import type { MomentWithHighlights, Topic } from "./analysisTypes.ts";

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

const mom = (id: string, o: Partial<MomentWithHighlights>): MomentWithHighlights => ({
  id, analysisId: "a", topicId: null, granularity: "passage", startMs: 0, endMs: 1000, title: id, why: "", relevance: 50,
  speakers: [], insideMomentId: null, evidence: [], checks: null, thumbKey: null, ownerId: null, origin: "ai", highlights: [], ...o,
});
const hl = (type: "heated" | "strong_argument" | "longest_speech" | "laughter", method: "ai" | "counted" = "ai") => ({ type, method, value: null });

describe("topHighlights", () => {
  it("picks the best per type in profile order", () => {
    const ms = [
      mom("a", { relevance: 40, highlights: [hl("strong_argument")] }),
      mom("b", { relevance: 80, highlights: [hl("strong_argument"), hl("heated")] }),
      mom("c", { relevance: 10, highlights: [hl("longest_speech", "counted")] }),
      mom("d", { relevance: 90, highlights: [hl("longest_speech", "ai")] }),
    ];
    const out = topHighlights(ms, "parliament");
    expect(out.map((x) => [x.type, x.moment.id])).toEqual([["heated", "b"], ["strong_argument", "b"], ["longest_speech", "c"]]);
  });

  it("prefers the shorter granularity on ties", () => {
    const ms = [
      mom("ex", { granularity: "exchange", relevance: 70, startMs: 0, highlights: [hl("heated")] }),
      mom("pu", { granularity: "punchline", relevance: 70, startMs: 500, highlights: [hl("heated")] }),
      mom("pa", { granularity: "passage", relevance: 70, startMs: 100, highlights: [hl("heated")] }),
    ];
    expect(topHighlights(ms, "other")[0]!.moment.id).toBe("pu");
    const same = [
      mom("late", { relevance: 70, startMs: 900, highlights: [hl("heated")] }),
      mom("early", { relevance: 70, startMs: 100, highlights: [hl("heated")] }),
    ];
    expect(topHighlights(same, "other")[0]!.moment.id).toBe("early");
  });
});

describe("mostDiscussedTopic", () => {
  it("picks the longest", () => {
    const t = (id: string, startMs: number, endMs: number): Topic => ({ id, analysisId: "a", idx: 0, startMs, endMs, title: id, summary: "" });
    expect(mostDiscussedTopic([t("a", 0, 10), t("b", 10, 100), t("c", 100, 150)])!.id).toBe("b");
    expect(mostDiscussedTopic([])).toBeNull();
  });
});

describe("topicForStart", () => {
  const topics = [
    { id: "t1", startMs: 0, endMs: 600_000 },
    { id: "t2", startMs: 600_000, endMs: 1_200_000 },
    { id: "t3", startMs: 1_500_000, endMs: 2_000_000 },
  ];
  it("picks the topic whose range holds the start (end exclusive)", () => {
    expect(topicForStart(topics, 0)?.id).toBe("t1");
    expect(topicForStart(topics, 600_000)?.id).toBe("t2");
    expect(topicForStart(topics, 1_999_999)?.id).toBe("t3");
  });
  it("falls back to the nearest topic in a gap, before the first or after the last; null without topics", () => {
    expect(topicForStart(topics, 1_250_000)?.id).toBe("t2");
    expect(topicForStart(topics, 1_450_000)?.id).toBe("t3");
    expect(topicForStart(topics, 5_000_000)?.id).toBe("t3");
    expect(topicForStart([{ id: "late", startMs: 10_000, endMs: 20_000 }], 0)?.id).toBe("late");
    expect(topicForStart([], 1000)).toBeNull();
  });
  it("never falls back to the first topic for a late moment (01:19:26 in a 1h39 interview)", () => {
    const merkel = [
      { id: "intro", startMs: 0, endMs: 615_736 },
      { id: "putin-calls", startMs: 4_629_065, endMs: 4_811_330 },
      { id: "russian", startMs: 4_811_330, endMs: 5_027_650 },
    ];
    expect(topicForStart(merkel, 4_766_012)?.id).toBe("putin-calls");
  });
});
