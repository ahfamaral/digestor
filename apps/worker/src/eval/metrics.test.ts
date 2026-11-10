import { describe, expect, it } from "vitest";
import type { Attribution, MomentChecks, Person, Word } from "@digestor/core";
import { attributionScore, highlightTypeRecall, momentRecall, topicBoundaryError, trapHits, uncheckedOnTraps, usageRows } from "./metrics.js";

const t = (startMs: number, endMs: number) => ({ title: "t", startMs, endMs });

describe("topicBoundaryError", () => {
  it("measures nearest boundaries", () => {
    const golden = [t(0, 100_000), t(100_000, 300_000)];
    const found = [t(0, 110_000), t(110_000, 290_000)];
    // golden boundaries 0, 100k, 300k -> nearest found 0, 110k, 290k -> errors 0, 10k, 10k
    const r = topicBoundaryError(golden, found);
    expect(r.meanMs).toBeCloseTo(6_666.67, 1);
    expect(r.maxMs).toBe(10_000);
  });

  it("is zero for identical topics and null-safe for empty input", () => {
    expect(topicBoundaryError([t(0, 5000)], [t(0, 5000)])).toEqual({ meanMs: 0, maxMs: 0 });
    expect(topicBoundaryError([], [t(0, 5000)])).toEqual({ meanMs: 0, maxMs: 0 });
    expect(topicBoundaryError([t(0, 5000)], [])).toEqual({ meanMs: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY });
  });
});

describe("momentRecall", () => {
  const g = (granularity: "exchange" | "passage" | "punchline", startMs: number, endMs: number) => ({ granularity, startMs, endMs, types: [] });
  it("uses 50% overlap per granularity", () => {
    const golden = [g("passage", 0, 10_000), g("passage", 20_000, 30_000), g("exchange", 0, 100_000)];
    const found = [
      g("passage", 4_000, 14_000), // 60% of golden -> hit
      g("passage", 28_000, 38_000), // 20% -> miss
      g("punchline", 20_000, 30_000), // wrong granularity -> ignored
    ];
    expect(momentRecall(golden, found, "passage")).toEqual({ found: 1, total: 2 });
    expect(momentRecall(golden, found, "exchange")).toEqual({ found: 0, total: 1 });
    expect(momentRecall(golden, found, "passage", 0.15)).toEqual({ found: 2, total: 2 });
  });
});

describe("momentRecall edge cases", () => {
  const g = (granularity: "exchange" | "passage" | "punchline", startMs: number, endMs: number) => ({ granularity, startMs, endMs });
  it("a zero-length golden moment is counted but never found", () => {
    expect(momentRecall([g("passage", 5_000, 5_000)], [g("passage", 0, 10_000)], "passage")).toEqual({ found: 0, total: 1 });
  });
  it("total 0 with no golden moments, and nothing found from an empty list", () => {
    expect(momentRecall([], [g("passage", 0, 10_000)], "passage")).toEqual({ found: 0, total: 0 });
    expect(momentRecall([g("passage", 0, 10_000)], [], "passage")).toEqual({ found: 0, total: 1 });
  });
});

describe("highlightTypeRecall", () => {
  const gm = (startMs: number, endMs: number, types: ("heated" | "key_point")[], granularity: "passage" | "exchange" = "passage") =>
    ({ granularity, startMs, endMs, types });
  const fm = (startMs: number, endMs: number, types: ("heated" | "key_point")[], granularity: "passage" | "exchange" = "passage") =>
    ({ granularity, startMs, endMs, highlights: types.map((type) => ({ type })) });

  it("needs the same granularity, half the golden length covered and a shared type; untyped golden moments don't count", () => {
    const golden = [gm(0, 10_000, ["heated"]), gm(20_000, 30_000, ["key_point"]), gm(40_000, 50_000, ["heated"]), gm(60_000, 70_000, [])];
    const found = [
      fm(4_000, 14_000, ["heated"]), // 60%, same type -> hit
      fm(20_000, 30_000, ["heated"]), // wrong type -> miss
      fm(40_000, 50_000, ["heated"], "exchange"), // wrong granularity -> miss
      fm(60_000, 70_000, ["heated"]),
    ];
    expect(highlightTypeRecall(golden, found)).toEqual({ found: 1, total: 3 });
  });
  it("a zero-length golden moment is never a hit (no division by zero)", () => {
    expect(highlightTypeRecall([gm(5_000, 5_000, ["heated"])], [fm(0, 10_000, ["heated"])])).toEqual({ found: 0, total: 1 });
  });
  it("touching but not overlapping is a miss", () => {
    expect(highlightTypeRecall([gm(0, 10_000, ["heated"])], [fm(10_000, 20_000, ["heated"])])).toEqual({ found: 0, total: 1 });
  });
  it("total 0 and an empty found list", () => {
    expect(highlightTypeRecall([], [fm(0, 10_000, ["heated"])])).toEqual({ found: 0, total: 0 });
    expect(highlightTypeRecall([gm(0, 10_000, ["heated"])], [])).toEqual({ found: 0, total: 1 });
  });
});

describe("trapHits", () => {
  it("total 0 with no traps, and nothing fired from an empty list", () => {
    expect(trapHits([], [{ startMs: 0, endMs: 5000, checks: null }])).toEqual({ fired: 0, total: 0 });
    expect(trapHits([{ kind: "quoted_opponent", startMs: 0, endMs: 5000 }], [])).toEqual({ fired: 0, total: 1 });
  });

  const checks = (over: Partial<MomentChecks>): MomentChecks => ({
    argumentComplete: true,
    continuesWith: null,
    unansweredQuestion: false,
    contextRisk: null,
    reportedSpeech: false,
    interpreter: false,
    ...over,
  });
  it("counts fired warnings", () => {
    const traps = [
      { kind: "mid_argument" as const, startMs: 0, endMs: 10_000 },
      { kind: "quoted_opponent" as const, startMs: 50_000, endMs: 60_000 },
      { kind: "mid_argument" as const, startMs: 90_000, endMs: 95_000 },
    ];
    const found = [
      { startMs: 1_000, endMs: 9_000, checks: checks({ argumentComplete: false, continuesWith: "next" }) },
      { startMs: 52_000, endMs: 58_000, checks: checks({}) }, // quoted opponent not flagged
      { startMs: 200_000, endMs: 210_000, checks: checks({ argumentComplete: false }) }, // elsewhere
    ];
    expect(trapHits(traps, found)).toEqual({ fired: 1, total: 3 });
    found[1] = { startMs: 52_000, endMs: 58_000, checks: checks({ reportedSpeech: true }) };
    expect(trapHits(traps, found)).toEqual({ fired: 2, total: 3 });
  });

  it("ignores moments whose checks never ran", () => {
    expect(trapHits([{ kind: "mid_argument", startMs: 0, endMs: 5000 }], [{ startMs: 0, endMs: 5000, checks: null }])).toEqual({ fired: 0, total: 1 });
  });
});

describe("uncheckedOnTraps", () => {
  it("keeps only unchecked moments that overlap a trap", () => {
    const checked = { argumentComplete: true } as MomentChecks;
    const traps = [{ startMs: 10_000, endMs: 20_000 }];
    const moments = [
      { id: "a", startMs: 15_000, endMs: 30_000, checks: null },
      { id: "b", startMs: 12_000, endMs: 18_000, checks: checked },
      { id: "c", startMs: 20_000, endMs: 25_000, checks: null }, // touches the end only
      { id: "d", startMs: 0, endMs: 40_000, checks: null },
    ];
    expect(uncheckedOnTraps(traps, moments).map((m) => m.id)).toEqual(["a", "d"]);
  });
});

describe("attributionScore", () => {
  const person = (id: string, displayName: string, fullName: string | null = null): Person => ({
    id, displayName, fullName, kind: "custom", party: null, state: null, role: null, photoUrl: null, officialIds: {},
  });
  const att = (speakerId: string, personId: string | null, over: Partial<Attribution> = {}): Attribution => ({
    id: `${speakerId}-${personId}-${over.source ?? "human"}`, sessionId: "s", speakerId, startMs: null, endMs: null, personId,
    source: "human", status: "confirmed", confidence: 1, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(0), supersededAt: null, ...over,
  });
  const word = (speaker: string, startMs: number, endMs: number): Word => ({ text: "x", startMs, endMs, speaker, confidence: 1 }) as Word;
  const persons = [person("p1", "Tralli", "César Tralli"), person("p2", "Flávio Bolsonaro"), person("p3", "Lula")];

  it("weights wrong names five times", () => {
    const words = [word("A", 0, 10_000), word("B", 10_000, 12_000), word("C", 12_000, 15_000)];
    const golden = [
      { startMs: 0, endMs: 10_000, person: "César Tralli" },
      { startMs: 10_000, endMs: 12_000, person: "Luiz Inácio Lula da Silva" },
      { startMs: 12_000, endMs: 15_000, person: "Flávio Bolsonaro" },
    ];
    const atts = [att("A", "p1"), att("B", "p2")];
    const r = attributionScore(golden, words, atts, persons);
    expect(r).toMatchObject({ correctMs: 10_000, wrongMs: 2_000, unnamedMs: 3_000, totalMs: 15_000, correctConfirmedMs: 10_000, score: 0 });
  });

  it("skips null spans and treats conflict as unnamed", () => {
    const words = [word("A", 0, 4_000), word("B", 4_000, 6_000), word("C", 6_000, 9_000)];
    const golden = [
      { startMs: 0, endMs: 4_000, person: null },
      { startMs: 4_000, endMs: 6_000, person: "Flávio Bolsonaro" },
      { startMs: 6_000, endMs: 9_000, person: "Lula" },
    ];
    const atts = [
      att("B", "p2", { source: "transcript", status: "proposed" }),
      att("B", "p3", { source: "metadata", status: "proposed" }),
      att("C", "p3", { source: "transcript", status: "proposed" }),
    ];
    const r = attributionScore(golden, words, atts, persons);
    expect(r).toMatchObject({ correctMs: 3_000, wrongMs: 0, unnamedMs: 2_000, totalMs: 5_000, correctConfirmedMs: 0 });
    expect(r.score).toBeCloseTo(0.6);
  });

  it("counts a name as right when its tokens are a subset of the golden name's", () => {
    const r = attributionScore([{ startMs: 0, endMs: 1_000, person: "Luiz Inácio Lula da Silva" }], [word("C", 0, 1_000)], [att("C", "p3")], persons);
    expect(r.correctMs).toBe(1_000);
  });
});

describe("usageRows", () => {
  const u = (calls: number, costUsd: number, unpricedCalls = 0) => ({ calls, inputTokens: 120_000, outputTokens: 8_000, reasoningTokens: 2_000, costUsd, unpricedCalls });

  it("totals the run, gives the cost per hour of video and one row per model, most expensive first", () => {
    const rows = usageRows("analysis", { "a/cheap": u(10, 0.01), "b/dear": u(5, 0.1) }, 2 * 3_600_000);
    expect(rows).toEqual([
      ["LLM cost, analysis", "$0.110 ($0.055 per hour of video) · 15 calls"],
      ["LLM use, analysis, b/dear", "5 calls · 120k in / 8000 out (2000 thinking) · $0.100"],
      ["LLM use, analysis, a/cheap", "10 calls · 120k in / 8000 out (2000 thinking) · $0.010"],
    ]);
  });

  it("says when calls had no price, and when nothing was recorded", () => {
    expect(usageRows("checks run now", { m: u(3, 0.002, 1) }, null)[0]).toEqual(["LLM cost, checks run now", "$0.0020 · 3 calls, 1 without a price (not counted)"]);
    expect(usageRows("analysis", {}, 1000)).toEqual([["LLM cost, analysis", "not recorded (version made before 2026-11-10, or no LLM calls)"]]);
  });
});
