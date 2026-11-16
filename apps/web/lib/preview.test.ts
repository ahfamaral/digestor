import { describe, expect, it } from "vitest";
import type { BriefingContent, MomentWithHighlights, Topic } from "@digestor/core";
import { buildSections, groupTopHighlights, latestFailedAfter, mostDiscussedCard, splitFirstSentence, versionNote } from "./preview";

const topic = (id: string, idx: number, startMs: number, endMs: number): Topic => ({
  id, analysisId: "a", idx, startMs, endMs, title: `Topic ${id}`, summary: `Summary ${id}`,
});
const moment = (id: string, topicId: string | null, startMs: number, relevance: number, types: MomentWithHighlights["highlights"][number]["type"][]): MomentWithHighlights => ({
  id, analysisId: "a", topicId, granularity: "passage", startMs, endMs: startMs + 30_000, title: id, why: "w", relevance,
  speakers: ["A"], insideMomentId: null, evidence: [], checks: null, thumbKey: null, ownerId: null, origin: "ai",
  highlights: types.map((type) => ({ type, method: "ai" as const, value: null })),
});

describe("buildSections", () => {
  const topics = [topic("t1", 0, 0, 100_000), topic("t2", 1, 100_000, 200_000)];

  it("one section per topic with the briefing summary (else the topic's own) and the key quote with its time", () => {
    const moments = [
      moment("weak-heated", "t1", 10_000, 50, ["heated"]),
      moment("best-heated", "t1", 40_000, 90, ["heated"]),
      moment("key", "t1", 20_000, 70, ["key_point"]),
      moment("orphan-light", null, 150_000, 60, ["light"]),
      moment("not-a-profile-type", "t2", 120_000, 99, ["vote"]),
    ];
    const briefing: BriefingContent = {
      lead: [],
      sections: [{ topicId: "t1", summary: [{ text: "One.", momentIds: [] }, { text: "Two.", momentIds: [] }], keyQuote: { momentId: "key", text: "Quoted." } }],
    };
    const sections = buildSections(topics, moments, briefing);
    expect(sections.map((s) => [s.n, s.topic.id, s.summary, s.fromBriefing])).toEqual([
      [1, "t1", "One. Two.", true],
      [2, "t2", "Summary t2", false],
    ]);
    expect(sections[0]!.keyQuote).toEqual({ momentId: "key", text: "Quoted.", startMs: 20_000 });
    expect(sections[1]!.keyQuote).toBeNull();
  });

  it("a key quote whose moment is gone keeps its text without a time", () => {
    const briefing: BriefingContent = { lead: [], sections: [{ topicId: "t2", summary: [], keyQuote: { momentId: "gone", text: "Q." } }] };
    expect(buildSections(topics, [], briefing)[1]!.keyQuote).toEqual({ momentId: "gone", text: "Q.", startMs: null });
  });
});

describe("splitFirstSentence", () => {
  it("splits after the first sentence end followed by a space", () => {
    expect(splitFirstSentence("One. Two! Three?")).toEqual({ first: "One.", rest: "Two! Three?" });
    expect(splitFirstSentence("Es kostet 19.5 Milliarden. Ja.")).toEqual({ first: "Es kostet 19.5 Milliarden.", rest: "Ja." });
  });
  it("handles CJK full stops without a space, and a single sentence", () => {
    expect(splitFirstSentence("最初の文。次の文。")).toEqual({ first: "最初の文。", rest: "次の文。" });
    expect(splitFirstSentence("  Only one sentence.  ")).toEqual({ first: "Only one sentence.", rest: "" });
    expect(splitFirstSentence("")).toEqual({ first: "", rest: "" });
  });
});

describe("versionNote", () => {
  const v = (id: string, version: number, profile: string, reason: string) => ({ id, version, profile, reason });

  it("explains a re-run, naming a profile change", () => {
    expect(versionNote([v("a", 1, "interview", "initial")], "a")).toBeNull();
    expect(versionNote([v("a", 1, "interview", "initial"), v("b", 2, "parliament", "Re-analysed as Parliament")], "b")).toBe(
      "Re-run: profile changed to Parliament",
    );
    expect(versionNote([v("a", 1, "interview", "initial"), v("b", 2, "interview", "Better topics")], "b")).toBe("Re-run: Better topics");
  });
});

describe("mostDiscussedCard", () => {
  it("is a counted value that says what was counted", () => {
    expect(mostDiscussedCard([topic("t1", 0, 0, 240_000), topic("t2", 1, 240_000, 3_900_000)])).toEqual({
      topicId: "t2",
      title: "Topic t2",
      startMs: 240_000,
      method: "counted",
      detail: "61m by speaking time",
    });
    expect(mostDiscussedCard([])).toBeNull();
  });
});

describe("latestFailedAfter", () => {
  const v = (id: string, version: number, status: "running" | "complete" | "failed") => ({ id, version, status });

  it("names a failed re-run newer than the shown version, until a newer one succeeds or starts", () => {
    expect(latestFailedAfter([v("a", 1, "complete")], "a")).toBeNull();
    expect(latestFailedAfter([v("a", 1, "complete"), v("b", 2, "failed"), v("c", 3, "failed")], "a")).toBe(3);
    // a newer run started: the running notice takes over
    expect(latestFailedAfter([v("a", 1, "complete"), v("b", 2, "failed"), v("c", 3, "running")], "a")).toBeNull();
    // a newer run succeeded and is now the shown version
    expect(latestFailedAfter([v("a", 1, "complete"), v("b", 2, "failed"), v("c", 3, "complete")], "c")).toBeNull();
    // an old failure before the shown version doesn't count
    expect(latestFailedAfter([v("a", 1, "failed"), v("b", 2, "complete")], "b")).toBeNull();
    expect(latestFailedAfter([v("b", 2, "failed")], "missing")).toBeNull();
  });
});

describe("groupTopHighlights", () => {
  it("gives a moment that tops several types one card with every chip, in type order", () => {
    const a = moment("a", null, 10_000, 90, ["news_line", "dodge", "key_point"]);
    const b = moment("b", null, 50_000, 80, ["quotable"]);
    const cards = groupTopHighlights([
      { type: "news_line", moment: a },
      { type: "quotable", moment: b },
      { type: "dodge", moment: a },
      { type: "key_point", moment: a },
    ]);
    expect(cards.map((c) => c.moment.id)).toEqual(["a", "b"]);
    expect(cards[0].types.map((x) => x.type)).toEqual(["news_line", "dodge", "key_point"]);
    expect(cards[1].types.map((x) => x.type)).toEqual(["quotable"]);
  });
  it("keeps each chip's method", () => {
    const m = { ...moment("m", null, 0, 70, ["heated"]), highlights: [{ type: "heated" as const, method: "ai" as const, value: null }, { type: "longest_speech" as const, method: "counted" as const, value: null }] };
    const cards = groupTopHighlights([{ type: "heated", moment: m }, { type: "longest_speech", moment: m }]);
    expect(cards).toHaveLength(1);
    expect(cards[0].types).toEqual([{ type: "heated", method: "ai" }, { type: "longest_speech", method: "counted" }]);
  });
  it("is empty for no highlights", () => {
    expect(groupTopHighlights([])).toEqual([]);
  });
});
