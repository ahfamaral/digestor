import { describe, expect, it } from "vitest";
import { ANALYSIS_USD_PER_HOUR, CAPTIONS_USD, TRANSCRIPTION_USD_PER_HOUR, estimateCostUsd } from "./cost.ts";

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
