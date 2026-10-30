import { describe, expect, it } from "vitest";
import type { MomentChecks } from "@digestor/core";
import { momentRecall, topicBoundaryError, trapHits } from "./metrics.js";

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

describe("trapHits", () => {
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
