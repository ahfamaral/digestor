import { describe, expect, it } from "vitest";
import type { Word } from "./schemas.js";
import { renderTranscript, sliceWords, speakerShares, toSentences } from "./transcriptText.js";

const w = (text: string, startMs: number, endMs: number, speaker = "A"): Word => ({
  text,
  startMs,
  endMs,
  speaker,
  confidence: 0.9,
});

describe("toSentences", () => {
  it("splits on speaker change even without punctuation", () => {
    const s = toSentences([w("Olá", 0, 400, "A"), w("tudo", 450, 800, "A"), w("bem", 850, 1000, "B")]);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ startMs: 0, endMs: 800, speaker: "A", text: "Olá tudo" });
    expect(s[1]?.speaker).toBe("B");
  });

  it("splits on sentence-ending punctuation and on gaps >= 1500 ms", () => {
    const s = toSentences([w("Oi.", 0, 300), w("Sim", 400, 600), w("então", 2100, 2400)]);
    expect(s.map((x) => x.text)).toEqual(["Oi.", "Sim", "então"]);
  });

  it("joins CJK words without spaces", () => {
    const s = toSentences([w("你", 0, 100), w("好", 100, 200), w("ok", 250, 300)]);
    expect(s[0]?.text).toBe("你好 ok");
  });

  it("returns [] for no words", () => {
    expect(toSentences([])).toEqual([]);
  });
});

describe("renderTranscript", () => {
  it("renders [hh:mm:ss] speaker: text lines", () => {
    const s = toSentences([w("Nunca", 1000, 1300, "B"), w("prometemos", 1350, 1800, "B"), w("isso.", 1850, 2200, "B")]);
    expect(renderTranscript(s)).toBe("[00:00:01] B: Nunca prometemos isso.");
  });

  it("joins lines with newlines", () => {
    const out = renderTranscript([
      { startMs: 0, endMs: 1, speaker: "A", text: "x" },
      { startMs: 61000, endMs: 62000, speaker: "B", text: "y" },
    ]);
    expect(out).toBe("[00:00:00] A: x\n[00:01:01] B: y");
  });
});

describe("speakerShares", () => {
  it("returns fractions summing to 1", () => {
    const shares = speakerShares([w("a", 0, 1, "A"), w("b", 1, 2, "A"), w("c", 2, 3, "B"), w("d", 3, 4, "A")]);
    expect(shares).toEqual({ A: 0.75, B: 0.25 });
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("returns {} for no words", () => {
    expect(speakerShares([])).toEqual({});
  });
});

describe("sliceWords", () => {
  const words = [w("a", 0, 1000), w("b", 1000, 2000), w("c", 2000, 3000)];
  it("includes a word straddling the start", () => {
    expect(sliceWords(words, { startMs: 1500, endMs: 2500 }).map((x) => x.text)).toEqual(["b", "c"]);
  });
  it("excludes words only touching the edges", () => {
    expect(sliceWords(words, { startMs: 1000, endMs: 2000 }).map((x) => x.text)).toEqual(["b"]);
  });
});
