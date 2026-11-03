import { describe, expect, it } from "vitest";
import { CAPTIONS_USD, estimateCostUsd } from "./cost.ts";

describe("estimateCostUsd", () => {
  it("is the transcription price per hour", () => {
    expect(estimateCostUsd(90 * 60_000)).toBe(0.6);
  });
  it("estimateCostUsd adds captions for video", () => {
    expect(CAPTIONS_USD).toBe(0.1);
    expect(estimateCostUsd(90 * 60_000, { captions: true })).toBe(0.7);
    expect(estimateCostUsd(90 * 60_000, { captions: false })).toBe(0.6);
  });
});
