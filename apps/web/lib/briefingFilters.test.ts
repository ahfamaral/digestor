import { describe, expect, it } from "vitest";
import type { Granularity, HighlightTypeId, MomentWithHighlights, SelectionStatus, Topic } from "@digestor/core";
import { DEFAULT_FILTERS, filterMoments, fromSearchParams, groupByTopic, toSearchParams, type BriefingFilters, type MomentView } from "./briefingFilters";

const topic = (id: string, idx: number, startMs: number, endMs: number): Topic => ({
  id, analysisId: "a", idx, startMs, endMs, title: id, summary: "",
});
const topics = [topic("t1", 0, 0, 300_000), topic("t2", 1, 300_000, 600_000)];

function moment(
  id: string,
  granularity: Granularity,
  topicId: string | null,
  startS: number,
  endS: number,
  over: { speakers?: string[]; relevance?: number; types?: HighlightTypeId[]; inside?: string; origin?: MomentWithHighlights["origin"] } = {},
): MomentWithHighlights {
  const origin = over.origin ?? "ai";
  return {
    id, analysisId: "a", topicId, granularity, startMs: startS * 1000, endMs: endS * 1000, title: id, why: "w",
    relevance: over.relevance ?? 50, speakers: over.speakers ?? ["A"], insideMomentId: over.inside ?? null, evidence: [],
    checks: null, thumbKey: null, ownerId: origin === "ask" || origin === "user" ? "owner" : null, origin,
    highlights: (over.types ?? []).map((type) => ({ type, method: origin === "counted" ? ("counted" as const) : ("ai" as const), value: null })),
  };
}

// t1: ex1 (A,B) holds pa1 (A), pu1 (B), pa2 (A) · t2: ex2 (A) holds pu2 (B); a counted exchange; a personal passage.
const ex1 = moment("ex1", "exchange", "t1", 0, 200, { speakers: ["A", "B"], relevance: 80, types: ["key_point"] });
const pa1 = moment("pa1", "passage", "t1", 10, 60, { relevance: 90, types: ["news_line"], inside: "ex1" });
const pu1 = moment("pu1", "punchline", "t1", 20, 35, { speakers: ["B"], relevance: 70, types: ["quotable"], inside: "ex1" });
const pa2 = moment("pa2", "passage", "t1", 100, 140, { relevance: 30, types: ["dodge"], inside: "ex1" });
const ex2 = moment("ex2", "exchange", "t2", 300, 500, { relevance: 60, types: ["heated"] });
const pu2 = moment("pu2", "punchline", "t2", 310, 320, { speakers: ["B"], relevance: 85, types: ["light"], inside: "ex2" });
const cnt = moment("cnt", "exchange", "t2", 400, 560, { relevance: 5, types: ["longest_speech"], origin: "counted" });
const mine = moment("mine", "passage", "t2", 330, 380, { relevance: 0, speakers: ["A"], origin: "user" });
const all = [ex1, pa1, pu1, pa2, ex2, pu2, cnt, mine];

const f = (over: Partial<BriefingFilters> = {}): BriefingFilters => ({ ...DEFAULT_FILTERS, ...over });
/** `[id, [child ids…]]` per top-level row (children listed recursively the same way). */
type Shape = [string, Shape[]];
const shape = (views: MomentView[]): Shape[] => views.map((v) => [v.moment.id, shape(v.children)]);

describe("filterMoments", () => {
  it("filterMoments nests punchlines under their exchange", () => {
    expect(shape(filterMoments(all, {}, f(), topics))).toEqual([
      ["ex1", [["pa1", []], ["pu1", []], ["pa2", []]]],
      ["ex2", [["pu2", []]]],
      ["cnt", []],
    ]);
  });

  it("the selected level is the primary list; coarser levels are not shown", () => {
    expect(shape(filterMoments(all, {}, f({ granularity: "punchline" }), topics))).toEqual([["pu1", []], ["pu2", []]]);
    expect(shape(filterMoments(all, {}, f({ granularity: "passage" }), topics))).toEqual([["pa1", []], ["pa2", []], ["mine", []]]);
  });

  it("a finer moment whose parent is filtered out shows at the top level only at its own granularity, else it is hidden", () => {
    // Focus B: ex2 (A only) drops out, so pu2 (B) is hidden at Exchange…
    expect(shape(filterMoments(all, {}, f({ speaker: "B" }), topics))).toEqual([["ex1", [["pu1", []]]]]);
    // …and shown on its own at Punchline.
    expect(shape(filterMoments(all, {}, f({ granularity: "punchline", speaker: "B" }), topics))).toEqual([["pu1", []], ["pu2", []]]);
  });

  it("focus keeps only moments with the speaker", () => {
    const views = filterMoments(all, {}, f({ granularity: "passage", speaker: "B" }), topics);
    expect(shape(views)).toEqual([]);
    const a = filterMoments(all, {}, f({ speaker: "A" }), topics);
    expect(shape(a)).toEqual([
      ["ex1", [["pa1", []], ["pa2", []]]],
      ["ex2", []],
      ["cnt", []],
    ]);
    expect(shape(filterMoments(all, {}, f({ speaker: "Z" }), topics))).toEqual([]);
  });

  it("counted moments ignore min relevance (personal moments too: they have no score)", () => {
    expect(shape(filterMoments(all, {}, f({ minRelevance: 75 }), topics))).toEqual([
      ["ex1", [["pa1", []]]],
      ["cnt", []],
    ]);
    expect(shape(filterMoments(all, {}, f({ granularity: "passage", minRelevance: 75 }), topics))).toEqual([["pa1", []], ["mine", []]]);
    expect(shape(filterMoments(all, {}, f({ minRelevance: 100 }), topics))).toEqual([["cnt", []]]);
  });

  it("type chips keep moments with any of the chosen types; none chosen means all types", () => {
    expect(shape(filterMoments(all, {}, f({ types: ["key_point", "heated"] }), topics))).toEqual([["ex1", []], ["ex2", []]]);
    expect(shape(filterMoments(all, {}, f({ granularity: "punchline", types: ["light"] }), topics))).toEqual([["pu2", []]]);
    expect(shape(filterMoments(all, {}, f({ types: [] }), topics))).toHaveLength(3);
  });

  it("show=open hides neutral and rejected", () => {
    const sel: Record<string, SelectionStatus> = { ex1: "approved", pa1: "neutral", pu1: "rejected", ex2: "rejected" };
    const open = filterMoments(all, sel, f(), topics);
    expect(shape(open)).toEqual([
      ["ex1", [["pa2", []]]],
      ["cnt", []],
    ]);
    expect(open[0]!.status).toBe("approved");
    expect(open[0]!.children[0]!.status).toBeNull();
    expect(shape(filterMoments(all, sel, f({ show: "rejected" }), topics))).toEqual([["ex2", []]]);
    expect(shape(filterMoments(all, sel, f({ show: "approved" }), topics))).toEqual([["ex1", []]]);
    expect(shape(filterMoments(all, sel, f({ show: "neutral", granularity: "passage" }), topics))).toEqual([["pa1", []]]);
    expect(shape(filterMoments(all, sel, f({ show: "all" }), topics))).toEqual([
      ["ex1", [["pa1", []], ["pu1", []], ["pa2", []]]],
      ["ex2", [["pu2", []]]],
      ["cnt", []],
    ]);
  });

  it("orders by topic, then by start; moments without a known topic go by the topic covering their start", () => {
    const late = moment("late-t1", "passage", "t1", 290, 320);
    const early = moment("early-t2", "passage", "t2", 280, 310);
    const loose = moment("loose", "passage", null, 50, 80);
    expect(shape(filterMoments([early, late, loose], {}, f({ granularity: "passage" }), topics))).toEqual([
      ["loose", []],
      ["late-t1", []],
      ["early-t2", []],
    ]);
  });

  it("personal moments are never nested", () => {
    const ask = { ...moment("ask", "punchline", "t1", 22, 30, { origin: "ask" }), insideMomentId: "ex1" };
    expect(shape(filterMoments([ex1, ask], {}, f(), topics))).toEqual([["ex1", []]]);
    expect(shape(filterMoments([ex1, ask], {}, f({ granularity: "punchline" }), topics))).toEqual([["ask", []]]);
  });
});

describe("groupByTopic", () => {
  it("one group per topic that has shown moments, in topic order; moments outside every topic go last", () => {
    const outside = moment("outside", "exchange", null, 700, 800);
    const views = filterMoments([...all, outside], {}, f(), topics);
    expect(groupByTopic(views, topics).map((g) => [g.topic?.id ?? null, g.views.map((v) => v.moment.id)])).toEqual([
      ["t1", ["ex1"]],
      ["t2", ["ex2", "cnt"]],
      [null, ["outside"]],
    ]);
    expect(groupByTopic([], topics)).toEqual([]);
  });
});

describe("search params", () => {
  it("filter state round-trips through search params", () => {
    const state: BriefingFilters = { granularity: "passage", speaker: "B", minRelevance: 40, types: ["heated", "laughter"], show: "all" };
    const qs = toSearchParams(state);
    expect(qs).toBe("g=passage&s=B&r=40&t=heated,laughter&show=all");
    expect(fromSearchParams(new URLSearchParams(qs))).toEqual(state);
    // defaults are omitted
    expect(toSearchParams(DEFAULT_FILTERS)).toBe("");
    expect(toSearchParams(f({ minRelevance: 40 }))).toBe("r=40");
    expect(fromSearchParams(new URLSearchParams(""))).toEqual(DEFAULT_FILTERS);
  });

  it("unknown or invalid values fall back to the defaults", () => {
    expect(fromSearchParams(new URLSearchParams("g=huge&r=140&show=weird&t=bogus"))).toEqual(DEFAULT_FILTERS);
    expect(fromSearchParams(new URLSearchParams("r=abc")).minRelevance).toBe(0);
    expect(fromSearchParams(new URLSearchParams("r=-5")).minRelevance).toBe(0);
    expect(fromSearchParams(new URLSearchParams("r=40.5")).minRelevance).toBe(0);
    expect(fromSearchParams(new URLSearchParams("r=100")).minRelevance).toBe(100);
    expect(fromSearchParams(new URLSearchParams("t=heated,bogus,heated")).types).toEqual(["heated"]);
    expect(fromSearchParams(new URLSearchParams("s=")).speaker).toBeNull();
    // with the session's speakers known, an unknown one is dropped
    expect(fromSearchParams(new URLSearchParams("s=Z"), { speakers: ["A", "B"] }).speaker).toBeNull();
    expect(fromSearchParams(new URLSearchParams("s=B"), { speakers: ["A", "B"] }).speaker).toBe("B");
  });

  it("a speaker id with URL-special characters survives the round trip", () => {
    const state = f({ speaker: "spk 1&2" });
    expect(fromSearchParams(new URLSearchParams(toSearchParams(state)))).toEqual(state);
  });
});
