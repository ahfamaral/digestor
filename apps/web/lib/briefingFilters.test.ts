import { describe, expect, it } from "vitest";
import type { Granularity, HighlightTypeId, MomentWithHighlights, SelectionStatus, Topic } from "@digestor/core";
import {
  DEFAULT_FILTERS, SHOW_HIDDEN_FILTERS, filterMoments, fromSearchParams, groupByTopic, hiddenApprovedCount, toSearchParams, type BriefingFilters,
  type MomentView,
} from "./briefingFilters";
import { peopleByMoment } from "./briefingData";
import type { Attribution, Person, Word } from "@digestor/core";

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
const found = moment("found", "exchange", "t2", 600, 700, { relevance: 40, origin: "find_more" });
const mine = moment("mine", "passage", "t2", 330, 380, { relevance: 0, speakers: ["A"], origin: "user" });
const all = [ex1, pa1, pu1, pa2, ex2, pu2, cnt, mine];

/** Every level ticked (most cases below are about nesting, so punchlines are in); the page's default is `DEFAULT_FILTERS`. */
const f = (over: Partial<BriefingFilters> = {}): BriefingFilters => ({ ...DEFAULT_FILTERS, levels: ["exchange", "passage", "punchline"], ...over });
/** `[id, [child ids…]]` per top-level row (children listed recursively the same way). */
type Shape = [string, Shape[]];
const shape = (views: MomentView[]): Shape[] => views.map((v) => [v.moment.id, shape(v.children)]);

describe("filterMoments", () => {
  it("the relevance floor applies to found moments (model-scored)", () => {
    const strong = moment("strong", "exchange", "t2", 700, 800, { relevance: 60, origin: "find_more" });
    expect(shape(filterMoments([found, strong], {}, f({ minRelevance: 50 }), topics)).map(([id]) => id)).toEqual(["strong"]);
    expect(shape(filterMoments([found, strong], {}, f(), topics)).map(([id]) => id)).toEqual(["found", "strong"]);
  });

  it("filterMoments nests punchlines under their exchange", () => {
    expect(shape(filterMoments(all, {}, f(), topics))).toEqual([
      ["ex1", [["pa1", []], ["pu1", []], ["pa2", []]]],
      ["ex2", [["pu2", []]]],
      ["mine", []],
      ["cnt", []],
    ]);
  });

  it("only ticked levels are listed; an unticked parent level is skipped when nesting", () => {
    expect(shape(filterMoments(all, {}, f({ levels: ["punchline"] }), topics))).toEqual([["pu1", []], ["pu2", []]]);
    expect(shape(filterMoments(all, {}, f({ levels: ["passage"] }), topics))).toEqual([["pa1", []], ["pa2", []], ["mine", []]]);
  });

  it("a passage with no exchange above it is a root, not hidden", () => {
    // Focus B: ex2 (A only) drops out, so pu2 (B) becomes a root of t2 instead of vanishing.
    expect(shape(filterMoments(all, {}, f({ speaker: "B" }), topics))).toEqual([["ex1", [["pu1", []]]], ["pu2", []]]);
    const lone = moment("lone", "passage", "t1", 10, 20, { inside: "gone" });
    expect(shape(filterMoments([lone], {}, f(), topics))).toEqual([["lone", []]]);
  });

  it("a punchline whose passage level is unticked attaches to its exchange", () => {
    const views = filterMoments(all, {}, f({ levels: ["exchange", "punchline"] }), topics);
    expect(shape(views)).toEqual([["ex1", [["pu1", []]]], ["ex2", [["pu2", []]]], ["cnt", []]]);
  });

  it("a punchline with no shown ancestor is a topic root", () => {
    expect(shape(filterMoments(all, {}, f({ levels: ["punchline"] }), topics))).toEqual([["pu1", []], ["pu2", []]]);
    // a punchline inside a passage inside an exchange, only punchline ticked
    const p = moment("p", "punchline", "t1", 12, 20, { inside: "pa1" });
    expect(shape(filterMoments([ex1, pa1, p], {}, f({ levels: ["punchline"] }), topics))).toEqual([["p", []]]);
  });

  it("an approved moment at an unticked level stays listed and keeps its children", () => {
    const sel: Record<string, SelectionStatus> = { pa1: "approved" };
    const inner = moment("inner", "punchline", "t1", 12, 18, { inside: "pa1" });
    expect(shape(filterMoments([...all, inner], sel, f({ levels: ["exchange", "punchline"] }), topics))).toEqual([
      ["ex1", [["pa1", [["inner", []]]], ["pu1", []]]],
      ["ex2", [["pu2", []]]],
      ["cnt", []],
    ]);
  });

  it("sticky ids stay listed under show=open after being skipped", () => {
    const sel: Record<string, SelectionStatus> = { ex2: "rejected" };
    expect(shape(filterMoments(all, sel, f(), topics)).map(([id]) => id)).not.toContain("ex2");
    expect(shape(filterMoments(all, sel, f(), topics, undefined, new Set(["ex2"]))).map(([id]) => id)).toContain("ex2");
    // sticky skips only the status filter: other filters still apply
    expect(shape(filterMoments(all, sel, f({ speaker: "B" }), topics, undefined, new Set(["ex2"]))).map(([id]) => id)).not.toContain("ex2");
  });

  it("self, missing, finer-parent and cyclic insideMomentId never hide or duplicate a moment", () => {
    const a = moment("a", "exchange", "t1", 0, 10, { inside: "a" });
    const b = moment("b", "passage", "t1", 20, 30, { inside: "nope" });
    const c = moment("c", "exchange", "t1", 40, 50, { inside: "d" });
    const d = moment("d", "punchline", "t1", 42, 48);
    const e = moment("e", "passage", "t1", 60, 70, { inside: "f" });
    const g = moment("f", "passage", "t1", 62, 68, { inside: "e" });
    const ms = [a, b, c, d, e, g];
    const flatten = (vs: MomentView[]): MomentView[] => vs.flatMap((v) => [v, ...flatten(v.children)]);
    const ids = flatten(filterMoments(ms, {}, f(), topics)).map((v) => v.moment.id).sort();
    expect(ids).toEqual(ms.map((m) => m.id).sort());
  });

  it("focus keeps only moments with the speaker", () => {
    const views = filterMoments(all, {}, f({ levels: ["passage"], speaker: "B" }), topics);
    expect(shape(views)).toEqual([]);
    const a = filterMoments(all, {}, f({ speaker: "A" }), topics);
    expect(shape(a)).toEqual([
      ["ex1", [["pa1", []], ["pa2", []]]],
      ["ex2", []],
      ["mine", []],
      ["cnt", []],
    ]);
    expect(shape(filterMoments(all, {}, f({ speaker: "Z" }), topics))).toEqual([]);
  });

  it("counted moments ignore min relevance (personal moments too: they have no score)", () => {
    expect(shape(filterMoments(all, {}, f({ minRelevance: 75 }), topics))).toEqual([
      ["ex1", [["pa1", []]]],
      ["pu2", []],
      ["mine", []],
      ["cnt", []],
    ]);
    expect(shape(filterMoments(all, {}, f({ levels: ["passage"], minRelevance: 75 }), topics))).toEqual([["pa1", []], ["mine", []]]);
    expect(shape(filterMoments(all, {}, f({ minRelevance: 100 }), topics))).toEqual([["mine", []], ["cnt", []]]);
  });

  it("type chips keep moments with any of the chosen types; none chosen means all types", () => {
    expect(shape(filterMoments(all, {}, f({ types: ["key_point", "heated"] }), topics))).toEqual([["ex1", []], ["ex2", []]]);
    expect(shape(filterMoments(all, {}, f({ levels: ["punchline"], types: ["light"] }), topics))).toEqual([["pu2", []]]);
    expect(shape(filterMoments(all, {}, f({ types: [] }), topics))).toHaveLength(4);
  });

  it("show=open hides skipped moments", () => {
    const sel: Record<string, SelectionStatus> = { ex1: "approved", pa1: "rejected", pu1: "rejected", ex2: "rejected" };
    const open = filterMoments(all, sel, f(), topics);
    expect(shape(open)).toEqual([
      ["ex1", [["pa2", []]]],
      ["pu2", []],
      ["mine", []],
      ["cnt", []],
    ]);
    expect(open[0]!.status).toBe("approved");
    expect(open[0]!.children[0]!.status).toBeNull();
    expect(shape(filterMoments(all, sel, f({ show: "skipped" }), topics))).toEqual([["pa1", []], ["pu1", []], ["ex2", []]]);
    expect(shape(filterMoments(all, sel, f({ show: "approved" }), topics))).toEqual([["ex1", []]]);
    expect(shape(filterMoments(all, sel, f({ show: "skipped", levels: ["passage"] }), topics))).toEqual([["pa1", []]]);
    expect(shape(filterMoments(all, sel, f({ show: "all" }), topics))).toEqual([
      ["ex1", [["pa1", []], ["pu1", []], ["pa2", []]]],
      ["ex2", [["pu2", []]]],
      ["mine", []],
      ["cnt", []],
    ]);
  });

  it("orders by topic, then by start; moments without a known topic go by the topic covering their start", () => {
    const late = moment("late-t1", "passage", "t1", 290, 320);
    const early = moment("early-t2", "passage", "t2", 280, 310);
    const loose = moment("loose", "passage", null, 50, 80);
    expect(shape(filterMoments([early, late, loose], {}, f({ levels: ["passage"] }), topics))).toEqual([
      ["loose", []],
      ["late-t1", []],
      ["early-t2", []],
    ]);
  });

  it("personal moments are never nested", () => {
    const ask = { ...moment("ask", "punchline", "t1", 22, 30, { origin: "ask" }), insideMomentId: "ex1" };
    expect(shape(filterMoments([ex1, ask], {}, f(), topics))).toEqual([["ex1", []], ["ask", []]]);
    expect(shape(filterMoments([ex1, ask], {}, f({ levels: ["punchline"] }), topics))).toEqual([["ask", []]]);
  });
});

describe("approved work is never invisible (Ruling R23)", () => {
  it("an approved passage stays visible, flattened under its topic, when its exchange is skipped", () => {
    const sel: Record<string, SelectionStatus> = { pa1: "approved", ex1: "rejected" };
    expect(shape(filterMoments(all, sel, f(), topics))).toEqual([
      ["pa1", []],
      ["pu1", []],
      ["pa2", []],
      ["ex2", [["pu2", []]]],
      ["mine", []],
      ["cnt", []],
    ]);
    // its proposed siblings are never hidden because their parent is
    expect(groupByTopic(filterMoments(all, sel, f(), topics), topics).map((g) => [g.topic?.id, g.views.map((v) => v.moment.id)])).toEqual([
      ["t1", ["pa1", "pu1", "pa2"]],
      ["t2", ["ex2", "mine", "cnt"]],
    ]);
  });

  it("an approved coarser moment stays listed at a finer level and holds its children", () => {
    const sel: Record<string, SelectionStatus> = { ex1: "approved" };
    expect(shape(filterMoments(all, sel, f({ levels: ["punchline"] }), topics))).toEqual([
      ["ex1", [["pu1", []]]],
      ["pu2", []],
    ]);
  });

  it("focus, type and relevance filters do not hide approved moments either", () => {
    const sel: Record<string, SelectionStatus> = { pu1: "approved" };
    // pu1 is Speaker B only, a quotable at 70: Focus A still lists it
    const ids = (fl: Partial<BriefingFilters>) => shape(filterMoments(all, sel, f({ levels: ["passage"], ...fl }), topics)).flatMap(function walk([id, kids]): string[] { return [id, ...(kids as typeof kids).flatMap(walk)]; });
    expect(ids({ speaker: "A" })).toContain("pu1");
    expect(ids({ types: ["heated"] })).toContain("pu1");
    expect(ids({ minRelevance: 95 })).toContain("pu1");
  });

  it("show=approved lists the approved moments, nested under approved ancestors, by topic then start", () => {
    const sel: Record<string, SelectionStatus> = { ex1: "approved", pu1: "approved", pu2: "approved", mine: "approved", pa2: "rejected" };
    expect(shape(filterMoments(all, sel, f({ show: "approved" }), topics))).toEqual([
      ["ex1", [["pu1", []]]],
      ["pu2", []],
      ["mine", []],
    ]);
    expect(shape(filterMoments(all, sel, f({ show: "approved", levels: ["punchline"] }), topics)).map(([id]) => id)).toEqual(["ex1", "pu2", "mine"]);
  });

  it("hiddenApprovedCount counts approved moments the current filters don't show; Show hidden reveals them all", () => {
    const sel: Record<string, SelectionStatus> = { pa1: "approved", pu1: "approved", ex2: "approved" };
    const ids = ["pa1", "pu1", "ex2"];
    expect(hiddenApprovedCount(filterMoments(all, sel, f(), topics), ids)).toBe(0);
    expect(hiddenApprovedCount(filterMoments(all, sel, f({ speaker: "A" }), topics), ids)).toBe(0); // pu1 (B) stays
    expect(hiddenApprovedCount(filterMoments(all, sel, f({ types: ["light"] }), topics), ids)).toBe(0);
    expect(hiddenApprovedCount(filterMoments(all, sel, f({ show: "skipped" }), topics), ids)).toBe(3);
    expect(SHOW_HIDDEN_FILTERS).toEqual({ ...DEFAULT_FILTERS, show: "approved" });
    expect(hiddenApprovedCount(filterMoments(all, sel, SHOW_HIDDEN_FILTERS, topics), ids)).toBe(0);
  });
});

describe("groupByTopic", () => {
  it("one group per topic that has shown moments, in topic order; moments outside every topic go last", () => {
    const outside = moment("outside", "exchange", null, 700, 800);
    const views = filterMoments([...all, outside], {}, f(), topics);
    expect(groupByTopic(views, topics).map((g) => [g.topic?.id ?? null, g.views.map((v) => v.moment.id)])).toEqual([
      ["t1", ["ex1"]],
      ["t2", ["ex2", "mine", "cnt"]],
      [null, ["outside"]],
    ]);
    expect(groupByTopic([], topics)).toEqual([]);
  });
});

describe("search params", () => {
  it("filter state round-trips through search params", () => {
    const state: BriefingFilters = { levels: ["exchange", "punchline"], speaker: "B", person: null, minRelevance: 40, types: ["heated", "laughter"], show: "all" };
    const qs = toSearchParams(state);
    expect(qs).toBe("lv=exchange,punchline&s=B&r=40&t=heated,laughter&show=all");
    expect(fromSearchParams(new URLSearchParams(qs))).toEqual(state);
    // defaults are omitted
    expect(toSearchParams(DEFAULT_FILTERS)).toBe("");
    expect(toSearchParams({ ...DEFAULT_FILTERS, minRelevance: 40 })).toBe("r=40");
    expect(fromSearchParams(new URLSearchParams(""))).toEqual(DEFAULT_FILTERS);
  });

  it("unknown or invalid values fall back to the defaults", () => {
    expect(fromSearchParams(new URLSearchParams("lv=huge&r=140&show=weird&t=bogus"))).toEqual(DEFAULT_FILTERS);
    expect(fromSearchParams(new URLSearchParams("lv="))).toEqual(DEFAULT_FILTERS);
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

  it("fromSearchParams: legacy g and show=neutral fall back to defaults", () => {
    expect(fromSearchParams(new URLSearchParams("g=passage&show=neutral"))).toEqual(DEFAULT_FILTERS);
    expect(fromSearchParams(new URLSearchParams("show=rejected"))).toEqual(DEFAULT_FILTERS);
  });

  it("the page opens on Exchanges and Passages; a URL with levels wins, all three included", () => {
    expect(DEFAULT_FILTERS.levels).toEqual(["exchange", "passage"]);
    expect(fromSearchParams(new URLSearchParams("")).levels).toEqual(["exchange", "passage"]);
    expect(fromSearchParams(new URLSearchParams("lv=punchline")).levels).toEqual(["punchline"]);
    const every = f();
    expect(toSearchParams(every)).toBe("lv=exchange,passage,punchline");
    expect(fromSearchParams(new URLSearchParams("lv=exchange,passage,punchline"))).toEqual(every);
  });

  it("by default punchlines are not listed, but an approved punchline is (nested under its exchange)", () => {
    expect(shape(filterMoments(all, {}, DEFAULT_FILTERS, topics))).toEqual([
      ["ex1", [["pa1", []], ["pa2", []]]],
      ["ex2", []],
      ["mine", []],
      ["cnt", []],
    ]);
    expect(shape(filterMoments(all, { pu2: "approved" }, DEFAULT_FILTERS, topics))).toEqual([
      ["ex1", [["pa1", []], ["pa2", []]]],
      ["ex2", [["pu2", []]]],
      ["mine", []],
      ["cnt", []],
    ]);
    expect(hiddenApprovedCount(filterMoments(all, { pu1: "approved" }, DEFAULT_FILTERS, topics), ["pu1"])).toBe(0);
  });

  it("levels round-trip through lv and default levels are omitted", () => {
    const x = { ...DEFAULT_FILTERS, levels: ["exchange", "punchline"] as Granularity[] };
    expect(toSearchParams(x)).toBe("lv=exchange,punchline");
    expect(fromSearchParams(new URLSearchParams("lv=exchange,punchline"))).toEqual(x);
    expect(toSearchParams(DEFAULT_FILTERS)).toBe("");
  });

  it("a speaker id with URL-special characters survives the round trip", () => {
    const state = f({ speaker: "spk 1&2" });
    expect(fromSearchParams(new URLSearchParams(toSearchParams(state)))).toEqual(state);
  });
});

// Person focus: P is voice B in turn 1 (0–10 s) and voice D in turn 5 (400–410 s); voice A is someone else.
const person = (id: string): Person => ({
  id, displayName: id, fullName: null, kind: "custom", party: null, state: null, role: null, photoUrl: null, officialIds: {},
});
const att = (o: Partial<Attribution>): Attribution => ({
  id: "a", sessionId: "s", speakerId: "B", startMs: null, endMs: null, personId: "P", source: "human", status: "confirmed",
  confidence: 1, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(0), supersededAt: null, ...o,
});
const run = (speaker: string, fromS: number, toS: number): Word[] =>
  Array.from({ length: toS - fromS }, (_, i) => ({ text: "x", startMs: (fromS + i) * 1000, endMs: (fromS + i) * 1000 + 900, speaker, confidence: 1 }) as Word);
const pm = (words: Word[], attributions: Attribution[]) =>
  peopleByMoment(all, { persons: [person("P")], attributions }, words);

describe("person focus", () => {
  it("person focus keeps moments where the person speaks at least 3 s", () => {
    // ex1 (0–200 s): P (voice B) speaks 0–4 s = 4 s; ex2 (300–400 s): P speaks 300–302 = 2 s only.
    const words = [...run("B", 0, 4), ...run("A", 4, 100), ...run("B", 300, 302), ...run("A", 302, 390)];
    const ctx = { peopleByMoment: pm(words, [att({ speakerId: "B" })]) };
    const ids = filterMoments(all, {}, f({ person: "P" }), topics, ctx).map((v) => v.moment.id);
    expect(ids).toContain("ex1");
    expect(ids).not.toContain("ex2");
  });

  it("person focus follows ranged record names across voices", () => {
    // P is voice B in turn 1 (0–10 s, inside ex1) and voice D in turn 5 (310–320 s, inside ex2).
    const words = [...run("B", 0, 10), ...run("A", 10, 100), ...run("D", 310, 320)];
    const atts = [att({ speakerId: "B", startMs: 0, endMs: 10_000 }), att({ speakerId: "D", startMs: 310_000, endMs: 320_000 })];
    const ids = filterMoments(all, {}, f({ person: "P" }), topics, { peopleByMoment: pm(words, atts) }).map((v) => v.moment.id);
    expect(ids).toEqual(expect.arrayContaining(["ex1", "ex2"]));
  });

  it("a person split across two voices in one moment sums to the 3 s", () => {
    const words = [...run("B", 0, 2), ...run("D", 2, 4)];
    const atts = [att({ speakerId: "B" }), att({ speakerId: "D" })];
    expect(pm(words, atts).get("ex1")).toEqual(new Set(["P"]));
  });

  it("in a sensitive profile only confirmed speech counts for a person", () => {
    // P confirmed on B (0–4 s, in ex1), only proposed on D (300–310 s, in ex2).
    const words = [...run("B", 0, 4), ...run("D", 300, 310)];
    const atts = [att({ speakerId: "B" }), att({ speakerId: "D", source: "caption", status: "proposed" })];
    const m = peopleByMoment(all, { persons: [person("P")], attributions: atts }, words, true);
    expect(m.get("ex1")).toEqual(new Set(["P"]));
    expect(m.get("ex2")).toEqual(new Set());
    expect(peopleByMoment(all, { persons: [person("P")], attributions: atts }, words, false).get("ex2")).toEqual(new Set(["P"]));
  });

  it("p= round-trips through the URL and an unknown person falls back to everyone", () => {
    const state = { ...DEFAULT_FILTERS, person: "p 1&2" };
    expect(toSearchParams(state)).toBe("p=p%201%262");
    expect(fromSearchParams(new URLSearchParams(toSearchParams(state)))).toEqual(state);
    expect(fromSearchParams(new URLSearchParams("p=P"), { persons: ["P"] }).person).toBe("P");
    expect(fromSearchParams(new URLSearchParams("p=Z"), { persons: ["P"] }).person).toBeNull();
    // person and speaker are exclusive: the person wins
    const both = fromSearchParams(new URLSearchParams("p=P&s=B"), { persons: ["P"] });
    expect(both.person).toBe("P");
    expect(both.speaker).toBeNull();
  });

  it("never hides an approved moment, whatever the type, level, focus or relevance filters", () => {
    const all = [ex1, pa2];
    const sel: Record<string, SelectionStatus> = { pa2: "approved" }; // pa2: dodge, relevance 30, speaker A, passage
    const f: BriefingFilters = { ...DEFAULT_FILTERS, types: ["key_point"], levels: ["exchange"], minRelevance: 70, speaker: "B" };
    const views = filterMoments(all, sel, f, topics);
    const ids = views.flatMap((v) => [v.moment.id, ...v.children.map((c) => c.moment.id)]);
    expect(ids).toContain("pa2");
    expect(hiddenApprovedCount(views, ["pa2"])).toBe(0);
  });
});
