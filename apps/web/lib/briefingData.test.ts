import { describe, expect, it } from "vitest";
import type { Word } from "@digestor/core";
import { earlierSelections, momentExcerpt, speakerOptions } from "./briefingData";

const w = (text: string, startS: number, speaker = "A"): Word => ({
  text, startMs: startS * 1000, endMs: startS * 1000 + 500, speaker, confidence: 0.9,
});

describe("momentExcerpt", () => {
  const words = [w("Before.", 0), w("We", 10), w("will", 11), w("build", 12), w("homes.", 13), w("After.", 30)];

  it("is the transcript's own words inside the moment", () => {
    expect(momentExcerpt(words, { startMs: 10_000, endMs: 14_000 })).toBe("We will build homes.");
  });

  it("cuts long text at a word boundary with an ellipsis", () => {
    expect(momentExcerpt(words, { startMs: 10_000, endMs: 14_000 }, 14)).toBe("We will build…");
    // a cut right after punctuation doesn't leave ".…"
    expect(momentExcerpt(words, { startMs: 10_000, endMs: 31_000 }, 22)).toBe("We will build homes…");
  });

  it("never splits a grapheme when there are no spaces (CJK)", () => {
    expect(momentExcerpt([w("東京都の家族です", 0)], { startMs: 0, endMs: 1_000 }, 3)).toBe("東京都…");
    expect(momentExcerpt([w("👩‍👩‍👧👩‍👩‍👧👩‍👩‍👧", 0)], { startMs: 0, endMs: 1_000 }, 2)).toBe("👩‍👩‍👧👩‍👩‍👧…");
  });

  it("is empty when the moment has no words", () => {
    expect(momentExcerpt(words, { startMs: 50_000, endMs: 60_000 })).toBe("");
  });
});

describe("speakerOptions", () => {
  it("lists the session's speakers with their share of the spoken words, in percent", () => {
    const words = [w("a", 0, "A"), w("b", 1, "A"), w("c", 2, "A"), w("d", 3, "B")];
    expect(speakerOptions(words, ["B", "A"])).toEqual([
      { id: "A", share: 75 },
      { id: "B", share: 25 },
    ]);
  });

  it("speakers known only from moments have no share; no transcript means no shares at all", () => {
    expect(speakerOptions([w("a", 0, "A")], ["C"])).toEqual([
      { id: "A", share: 100 },
      { id: "C", share: null },
    ]);
    expect(speakerOptions([], ["B", "A", "B"])).toEqual([
      { id: "A", share: null },
      { id: "B", share: null },
    ]);
  });

  it("a speaker with a tiny share shows below 1 % as 0 rather than disappearing", () => {
    const words = [...Array.from({ length: 300 }, (_, i) => w("x", i, "A")), w("y", 400, "B")];
    expect(speakerOptions(words, [])).toEqual([
      { id: "A", share: 100 },
      { id: "B", share: 0 },
    ]);
  });
});

describe("earlierSelections", () => {
  it("counts selections outside the current analysis and names the newest version holding them", () => {
    const rows = [
      { analysisId: "v1", version: 1, count: 2 },
      { analysisId: "v2", version: 2, count: 3 },
      { analysisId: "v3", version: 3, count: 4 },
    ];
    expect(earlierSelections(rows, "v3")).toEqual({ count: 5, version: 2 });
    expect(earlierSelections(rows.slice(2), "v3")).toBeNull();
    expect(earlierSelections([], "v3")).toBeNull();
  });
});
