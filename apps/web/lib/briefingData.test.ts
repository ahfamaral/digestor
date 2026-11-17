import { describe, expect, it } from "vitest";
import type { Word } from "@digestor/core";
import { currentSpeakerTitle, earlierSelections, focusOptions, insideApproved, momentExcerpt, withCurrentSpeakerNames } from "./briefingData";
import type { Attribution, Person } from "@digestor/core";

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

const person = (id: string, displayName: string): Person => ({
  id, displayName, fullName: null, kind: "custom", party: null, state: null, role: null, photoUrl: null, officialIds: {},
});
const att = (o: Partial<Attribution>): Attribution => ({
  id: "a", sessionId: "s", speakerId: "A", startMs: null, endMs: null, personId: "P", source: "human", status: "confirmed",
  confidence: 1, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(0), supersededAt: null, ...o,
});

describe("focusOptions", () => {
  // A: 6 words, B: 3 words, C: 1 word.
  const words = [...[0, 1, 2, 3, 4, 5].map((i) => w("a", i, "A")), ...[6, 7, 8].map((i) => w("b", i, "B")), w("c", 9, "C")];

  it("focusOptions lists persons by share, then unnamed voices", () => {
    const names = { persons: [person("P", "Ana"), person("Q", "Bia")], attributions: [att({ speakerId: "B", personId: "P" }), att({ speakerId: "C", personId: "Q" })] };
    expect(focusOptions(names, words)).toEqual([
      { kind: "person", personId: "P", share: 30 },
      { kind: "person", personId: "Q", share: 10 },
      { kind: "voice", speakerId: "A", share: 60 },
    ]);
  });

  it("a person across two voices is one option; ranged names resolve per word, not at 0", () => {
    // Voice A is P only from 3 s on: words 0–2 stay an unnamed voice A, words 3–5 plus voice B are P.
    const names = { persons: [person("P", "Ana")], attributions: [att({ speakerId: "A", personId: "P", startMs: 3000, endMs: 6000 }), att({ speakerId: "B", personId: "P" })] };
    expect(focusOptions(names, words)).toEqual([
      { kind: "person", personId: "P", share: 60 },
      { kind: "voice", speakerId: "A", share: 30 },
      { kind: "voice", speakerId: "C", share: 10 },
    ]);
  });

  it("an unconfirmed name in a sensitive profile is listed as its voice", () => {
    const names = { persons: [person("P", "Ana")], attributions: [att({ speakerId: "B", personId: "P", source: "caption", status: "proposed" })] };
    expect(focusOptions(names, words, true).map((o) => o.kind === "person" ? o.personId : o.speakerId)).toEqual(["A", "B", "C"]);
    expect(focusOptions(names, words, false)[0]).toEqual({ kind: "person", personId: "P", share: 30 });
  });

  it("a person without speech is not listed", () => {
    const names = { persons: [person("P", "Ana"), person("Z", "Zed")], attributions: [att({ speakerId: "B", personId: "P" })] };
    const opts = focusOptions(names, words);
    expect(opts.some((o) => o.kind === "person" && o.personId === "Z")).toBe(false);
  });

  it("a tiny share is 0, not missing", () => {
    const big = [...Array.from({ length: 300 }, (_, i) => w("x", i, "A")), w("y", 400, "B")];
    expect(focusOptions({ persons: [], attributions: [] }, big)).toEqual([
      { kind: "voice", speakerId: "A", share: 100 },
      { kind: "voice", speakerId: "B", share: 0 },
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

describe("insideApproved", () => {
  const v = (id: string, granularity: "exchange" | "passage" | "punchline", children: unknown[] = []) => ({
    moment: { id, granularity }, children,
  });
  const tree = [v("e1", "exchange", [v("p1", "passage", [v("k1", "punchline")]), v("p2", "passage")]), v("e2", "exchange")];

  it("is the granularity of the nearest approved ancestor", () => {
    expect(insideApproved("k1", new Set(["e1", "p1"]), tree)).toBe("passage");
    expect(insideApproved("k1", new Set(["e1"]), tree)).toBe("exchange");
    expect(insideApproved("p2", new Set(["e1", "p2"]), tree)).toBe("exchange");
  });
  it("is null with no approved ancestor (the moment's own approval does not count)", () => {
    expect(insideApproved("k1", new Set(["k1", "e2"]), tree)).toBeNull();
    expect(insideApproved("e1", new Set(["e1"]), tree)).toBeNull();
    expect(insideApproved("missing", new Set(["e1"]), tree)).toBeNull();
  });
});

describe("withCurrentSpeakerNames", () => {
  const counted = {
    id: "m1", analysisId: "v", topicId: null, parentId: null, granularity: "exchange", startMs: 60_000, endMs: 300_000,
    title: "Longest speech: E", why: "The longest uninterrupted speech in the session, by E, 00:04:00 long (counted from the transcript).",
    relevance: 100, speakers: ["E"], evidence: [], origin: "counted", highlights: [{ type: "longest_speech", method: "counted", value: 240 }],
  } as unknown as Parameters<typeof withCurrentSpeakerNames>[0][number];

  it("names the longest speech's speaker as the session names them now", () => {
    const names = { persons: [person("P", "Matthias Gastel")], attributions: [att({ speakerId: "E", personId: "P" })] };
    const [m] = withCurrentSpeakerNames([counted], names, false);
    expect(m.title).toBe("Longest speech: Matthias Gastel");
    expect(m.why).toContain("by Matthias Gastel, 00:04:00 long");
  });

  it("says Speaker E with no name, and withholds an unconfirmed name in a sensitive profile", () => {
    expect(withCurrentSpeakerNames([counted], { persons: [], attributions: [] }, false)[0].title).toBe("Longest speech: Speaker E");
    const proposed = { persons: [person("P", "Ana")], attributions: [att({ speakerId: "E", personId: "P", status: "proposed", source: "caption" })] };
    expect(withCurrentSpeakerNames([counted], proposed, true)[0].title).toBe("Longest speech: Speaker E");
  });

  it("leaves AI moments and edited titles alone", () => {
    const names = { persons: [person("P", "Matthias Gastel")], attributions: [att({ speakerId: "E", personId: "P" })] };
    const ai = { ...counted, origin: "ai", title: "Longest speech: E" } as typeof counted;
    const edited = { ...counted, title: "Gastel on rail" } as typeof counted;
    expect(withCurrentSpeakerNames([ai, edited], names, false)).toEqual([ai, edited]);
  });
  it("gives Prepare and Export the same title from a moment loaded without highlights", () => {
    const names = { persons: [person("P", "Matthias Gastel")], attributions: [att({ speakerId: "E", personId: "P" })] };
    expect(currentSpeakerTitle(counted, names, false)).toBe("Longest speech: Matthias Gastel");
    expect(currentSpeakerTitle({ ...counted, title: "Gastel on rail" }, names, false)).toBe("Gastel on rail");
    expect(currentSpeakerTitle({ ...counted, origin: "ai" }, names, false)).toBe("Longest speech: E");
  });
});
