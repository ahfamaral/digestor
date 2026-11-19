import { describe, expect, it } from "vitest";
import { sessionSpending } from "@digestor/core";
import { aboutUsd, packageCostUsd, readInCostText, recordedUsd, spendingLines, spentSoFarText } from "./cost";

describe("cost labels", () => {
  it("says 'about' for estimates and 'under $0.01' for tiny ones", () => {
    expect(aboutUsd(0.4249)).toBe("about $0.42");
    expect(aboutUsd(1.6)).toBe("about $1.60");
    expect(aboutUsd(0.001)).toBe("under $0.01");
  });
  it("shows recorded figures exactly, three decimals under ten cents", () => {
    expect(recordedUsd(0.1449)).toBe("$0.14");
    expect(recordedUsd(0.0345)).toBe("$0.035");
    expect(recordedUsd(0)).toBe("under $0.01");
  });
});

describe("readInCostText", () => {
  it("prices a briefing translation per language", () => {
    expect(readInCostText()).toBe("about $0.01 per language");
  });
});

describe("packageCostUsd", () => {
  const offered = [{ startMs: 0, endMs: 60_000 }, { startMs: 0, endMs: 120_000 }];
  const clips = [{ on: true, start: "", end: "" }, { on: false, start: "", end: "" }];
  it("prices translation of the ticked clips only", () => {
    expect(packageCostUsd(clips, offered, "en", "pt")).toBeCloseTo(0.002);
    expect(packageCostUsd(clips.map((c) => ({ ...c, on: true })), offered, "en", "pt")).toBeCloseTo(0.006);
  });
  it("follows edited times", () => {
    expect(packageCostUsd([{ on: true, start: "00:00:00", end: "00:05:00" }], offered, "en", "pt")).toBeCloseTo(0.01);
  });
  it("is free without subtitles or in the video's own language", () => {
    expect(packageCostUsd(clips, offered, null, "pt")).toBe(0);
    expect(packageCostUsd(clips, offered, "pt", "pt")).toBe(0);
  });
});

describe("spending lines", () => {
  const usage = { m: { calls: 79, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, costUsd: 0.145, unpricedCalls: 0 } };
  it("compares the estimate with what the analyses recorded", () => {
    const s = sessionSpending({ durationMs: 99 * 60_000, hasVideo: true, transcribed: true, analyses: [{ usage }] });
    const l = spendingLines(s);
    expect(l.summary).toBe("Estimated: about $0.60 · Recorded: $0.14");
    expect(l.detail).toBe(
      "Recorded is what the AI analyses stored (1 of 1 runs). Transcription, about $0.48, is always estimated. Ask, checks, subtitles, briefing translations and Find more aren't recorded.",
    );
  });
  it("says when nothing was recorded, and counts unpriced calls", () => {
    const s = sessionSpending({ durationMs: 60_000, hasVideo: false, transcribed: true, analyses: [{ usage: {} }] });
    expect(spendingLines(s).summary).toBe("Estimated: about $0.01 · Recorded: none yet");
    const u = sessionSpending({ durationMs: 60_000, hasVideo: false, transcribed: true, analyses: [{ usage: { x: { ...usage.m, unpricedCalls: 2 } } }] });
    expect(spendingLines(u).detail).toContain(" 2 calls had no price and aren't counted.");
  });
  it("words the Sessions page total", () => {
    expect(spentSoFarText({ bestUsd: 1.234, recordedUsd: 0.2 })).toEqual({ total: "Spent so far: about $1.23", detail: "$0.20 recorded, the rest estimated" });
  });
});
