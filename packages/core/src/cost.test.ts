import { describe, expect, it } from "vitest";
import {
  ANALYSIS_USD_PER_HOUR, ASK_USD_PER_QUESTION, CAPTIONS_USD, FIND_MORE_USD, LIBRARY_ASK_USD_PER_QUESTION, PROCESSING_USD_PER_HOUR,
  TRANSCRIPTION_USD_PER_HOUR, TRANSLATION_USD_PER_CLIP_MINUTE, estimateCostUsd, estimateReanalysisUsd, estimateTranslationUsd, priceKey,
  recordedCost, sessionSpending, totalSpending, usdAmount,
} from "./cost.ts";

describe("estimateCostUsd", () => {
  it("is transcription plus analysis per hour", () => {
    expect(TRANSCRIPTION_USD_PER_HOUR).toBe(0.23);
    expect(ANALYSIS_USD_PER_HOUR).toBe(0.07);
    expect(estimateCostUsd(90 * 60_000)).toBe(0.45);
    expect(estimateCostUsd(5.32 * 3_600_000)).toBe(1.6);
  });
  it("estimateCostUsd adds captions for video", () => {
    expect(CAPTIONS_USD).toBe(0.1);
    expect(estimateCostUsd(90 * 60_000, { captions: true })).toBe(0.55);
    expect(estimateCostUsd(90 * 60_000, { captions: false })).toBe(0.45);
  });
});


const use = (calls: number, costUsd: number, extra: Partial<{ inputTokens: number; outputTokens: number; unpricedCalls: number }> = {}) => ({
  calls, costUsd, inputTokens: extra.inputTokens ?? 0, outputTokens: extra.outputTokens ?? 0, reasoningTokens: 0, unpricedCalls: extra.unpricedCalls ?? 0,
});

describe("rates", () => {
  it("states the per-action rates", () => {
    expect(PROCESSING_USD_PER_HOUR).toBeCloseTo(0.3);
    expect(ASK_USD_PER_QUESTION).toBe(0.01);
    expect(LIBRARY_ASK_USD_PER_QUESTION).toBe(0.02);
    expect(TRANSLATION_USD_PER_CLIP_MINUTE).toBe(0.002);
    expect(FIND_MORE_USD).toBe(0.01);
  });
  it("prices a re-analysis as analysis only (no new transcription)", () => {
    expect(estimateReanalysisUsd(2 * 3_600_000)).toBeCloseTo(0.14);
    expect(estimateReanalysisUsd(-5)).toBe(0);
  });
  it("prices translation per clip minute, and nothing in the video's own language", () => {
    expect(estimateTranslationUsd(5 * 60_000)).toBeCloseTo(0.01);
    expect(estimateTranslationUsd(5 * 60_000, false)).toBe(0);
  });
});

describe("recordedCost", () => {
  it("sums the stored dollars and counts unpriced calls", () => {
    const r = recordedCost({ "anthropic/claude-haiku-5.5": use(10, 0.05), "x/unknown": use(2, 0, { unpricedCalls: 2, inputTokens: 1000 }) });
    expect(r.usd).toBeCloseTo(0.05);
    expect(r.calls).toBe(12);
    expect(r.unpricedCalls).toBe(2);
  });
  it("prices a fully unpriced known model from its tokens", () => {
    const r = recordedCost({ "claude-haiku-5-5-20261001": use(3, 0, { unpricedCalls: 3, inputTokens: 1_000_000, outputTokens: 200_000 }) });
    expect(r.usd).toBeCloseTo(0.2);
    expect(r.unpricedCalls).toBe(0);
  });
  it("is empty for missing usage", () => {
    expect(recordedCost({})).toEqual({ usd: 0, calls: 0, unpricedCalls: 0 });
    expect(recordedCost(null)).toEqual({ usd: 0, calls: 0, unpricedCalls: 0 });
  });
  it("normalises model ids for the price table", () => {
    expect(priceKey("openrouter:anthropic/claude-haiku-5.5")).toBe("claude-haiku-5-5");
    expect(priceKey("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });
});

describe("sessionSpending", () => {
  const hour = 3_600_000;
  it("estimates transcription once and analysis per version; best = recorded where metered", () => {
    const s = sessionSpending({ durationMs: hour, hasVideo: true, transcribed: true, analyses: [{ usage: {} }, { usage: { m: use(5, 0.09) } }] });
    expect(s.transcriptionUsd).toBeCloseTo(0.33);
    expect(s.estimatedUsd).toBeCloseTo(0.33 + 0.14);
    expect(s.recordedUsd).toBeCloseTo(0.09);
    expect(s.meteredAnalyses).toBe(1);
    expect(s.unmeteredAnalyses).toBe(1);
    expect(s.bestUsd).toBeCloseTo(0.33 + 0.09 + 0.07);
  });
  it("costs nothing before transcription and leaves captions out for audio", () => {
    expect(sessionSpending({ durationMs: hour, hasVideo: true, transcribed: false, analyses: [] }).bestUsd).toBe(0);
    expect(sessionSpending({ durationMs: hour, hasVideo: false, transcribed: true, analyses: [] }).transcriptionUsd).toBeCloseTo(0.23);
    expect(sessionSpending({ durationMs: null, hasVideo: false, transcribed: true, analyses: [{ usage: {} }] }).bestUsd).toBe(0);
  });
  it("totals sessions", () => {
    const a = sessionSpending({ durationMs: hour, hasVideo: false, transcribed: true, analyses: [{ usage: { m: use(1, 0.05) } }] });
    const t = totalSpending([a, a]);
    expect(t.bestUsd).toBeCloseTo(0.56);
    expect(t.recordedUsd).toBeCloseTo(0.1);
    expect(t.estimatedPartUsd).toBeCloseTo(0.46);
  });
});

describe("usdAmount", () => {
  it("formats amounts, with 'under' below half a cent", () => {
    expect(usdAmount(0.004)).toEqual({ under: true, amount: "0.01" });
    expect(usdAmount(0.005)).toEqual({ under: false, amount: "0.01" });
    expect(usdAmount(0.4249)).toEqual({ under: false, amount: "0.42" });
    expect(usdAmount(1.6)).toEqual({ under: false, amount: "1.60" });
    expect(usdAmount(0.0345, { precise: true })).toEqual({ under: false, amount: "0.035" });
    expect(usdAmount(Number.NaN).under).toBe(true);
  });
});
