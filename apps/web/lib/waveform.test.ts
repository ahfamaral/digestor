import { describe, expect, it } from "vitest";
import { sampleColumns, waveColumns, waveLines } from "./waveform";

describe("waveColumns", () => {
  it("averages the size of each column's samples, scaled so a pure tone reaches its peak", () => {
    const got = waveColumns([0.1, -0.5, 0.2, 0.05, -0.9, 0.3], 3);
    [0.3, 0.125, 0.6].forEach((mean, i) => expect(got[i]).toBeCloseTo(mean * (Math.PI / 2), 6));
    const tone = Array.from({ length: 4000 }, (_, i) => 0.5 * Math.sin(i / 10));
    expect(waveColumns(tone, 1)[0]).toBeCloseTo(0.5, 2);
  });
  it("silence is all zero; more columns than samples repeats them; none gives nothing", () => {
    expect(waveColumns(new Float32Array(8), 4)).toEqual([0, 0, 0, 0]);
    expect(waveColumns([0.5, -0.25], 4)).toEqual([0.5, 0.5, 0.25, 0.25].map((v) => v * (Math.PI / 2)));
    expect(waveColumns([0.5], 0)).toEqual([]);
    expect(waveColumns([], 3)).toEqual([]);
  });
  it("clips values beyond full scale", () => {
    expect(waveColumns([0.9, -2], 2)).toEqual([1, 1]);
  });
});

describe("sampleColumns", () => {
  it("is stable and stays between quiet and full scale", () => {
    const a = sampleColumns(200);
    expect(a).toEqual(sampleColumns(200));
    expect(Math.min(...a)).toBeGreaterThan(0);
    expect(Math.max(...a)).toBeLessThan(1);
  });
});

describe("waveLines", () => {
  it("centres each line on the middle, at least 1 px tall", () => {
    expect(waveLines([0, 0.5, 1], 30, 100)).toEqual([
      [0, 49.5, 1],
      [10, 25, 50],
      [20, 0, 100],
    ]);
  });
});
