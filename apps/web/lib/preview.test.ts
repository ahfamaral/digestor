import { describe, expect, it } from "vitest";
import type { BriefingContent, MomentWithHighlights, Topic } from "@digestor/core";
import { buildSections, versionNote } from "./preview";

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

  it("one section per topic with the briefing summary, quote time and the topic's best moment per type", () => {
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
    const sections = buildSections(topics, moments, briefing, "interview");
    expect(sections.map((s) => [s.n, s.topic.id, s.summary, s.fromBriefing])).toEqual([
      [1, "t1", "One. Two.", true],
      [2, "t2", "Summary t2", false],
    ]);
    expect(sections[0]!.keyQuote).toEqual({ momentId: "key", text: "Quoted.", startMs: 20_000 });
    expect(sections[1]!.keyQuote).toBeNull();
    // rows sorted by start; the weaker heated moment loses; the topic-less moment lands in the topic covering its start
    expect(sections[0]!.rows.map((m) => m.id)).toEqual(["key", "best-heated"]);
    expect(sections[1]!.rows.map((m) => m.id)).toEqual(["orphan-light"]);
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
