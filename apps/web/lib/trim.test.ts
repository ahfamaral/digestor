import { describe, expect, it } from "vitest";
import type { Boundary } from "@digestor/core";
import { clampHandle, cutPoints, nearestBoundary, stepHandle, trimView } from "./trim";

describe("trimView", () => {
  it("trimView maps ms and pct both ways", () => {
    const v = trimView({ startMs: 60_000, endMs: 90_000 }, 600_000);
    expect(v.viewStart).toBe(30_000);
    expect(v.viewEnd).toBe(120_000);
    expect(v.toPct(30_000)).toBe(0);
    expect(v.toPct(75_000)).toBe(50);
    expect(v.toPct(120_000)).toBe(100);
    expect(v.toMs(0)).toBe(30_000);
    expect(v.toMs(50)).toBe(75_000);
    expect(v.toMs(100)).toBe(120_000);
    for (const ms of [31_234, 60_000, 99_999]) expect(v.toMs(v.toPct(ms))).toBeCloseTo(ms, 6);
    // outside the strip clamps to its edges
    expect(v.toMs(-10)).toBe(30_000);
    expect(v.toMs(140)).toBe(120_000);
  });

  it("clamps the view to the video and honours a custom pad", () => {
    const v = trimView({ startMs: 10_000, endMs: 50_000 }, 60_000);
    expect([v.viewStart, v.viewEnd]).toEqual([0, 60_000]);
    const w = trimView({ startMs: 10_000, endMs: 20_000 }, 600_000, 5_000);
    expect([w.viewStart, w.viewEnd]).toEqual([5_000, 25_000]);
    // a degenerate view never divides by zero
    const z = trimView({ startMs: 0, endMs: 0 }, 0);
    expect(Number.isFinite(z.toPct(0))).toBe(true);
  });
});

describe("nearestBoundary", () => {
  it("nearestBoundary snaps within 2 s and not beyond", () => {
    const b = [1_000, 5_000, 9_000];
    expect(nearestBoundary(b, 5_400)).toBe(5_000);
    expect(nearestBoundary(b, 6_900)).toBe(5_000);
    expect(nearestBoundary(b, 7_100)).toBe(9_000);
    expect(nearestBoundary(b, 7_000)).toBe(5_000); // exactly 2 s: still snaps (tie keeps the earlier one)
    expect(nearestBoundary(b, 11_001)).toBeNull();
    expect(nearestBoundary(b, 3_000, 1_000)).toBeNull();
    expect(nearestBoundary([], 3_000)).toBeNull();
  });
});

describe("stepHandle", () => {
  const points = [10_000, 12_000, 20_000];

  it("moves by the step when snapping is off", () => {
    expect(stepHandle(points, 11_000, 100, false)).toBe(11_100);
    expect(stepHandle(points, 11_000, -1_000, false)).toBe(10_000);
  });

  it("with snapping, jumps to the next pause at least one step away in that direction", () => {
    expect(stepHandle(points, 10_000, 100, true)).toBe(12_000);
    expect(stepHandle(points, 12_000, 100, true)).toBe(20_000);
    expect(stepHandle(points, 12_000, -100, true)).toBe(10_000);
    expect(stepHandle(points, 11_500, 1_000, true)).toBe(20_000); // 12 000 is closer than one step
    // no pause that way: plain step
    expect(stepHandle(points, 20_000, 100, true)).toBe(20_100);
    expect(stepHandle(points, 10_000, -1_000, true)).toBe(9_000);
  });
});

describe("clampHandle", () => {
  it("keeps the handle inside the view and at least a second from the other handle", () => {
    const view = { viewStart: 0, viewEnd: 100_000 };
    expect(clampHandle("start", 50_000, { startMs: 10_000, endMs: 40_000 }, view)).toBe(39_000);
    expect(clampHandle("start", -5, { startMs: 10_000, endMs: 40_000 }, view)).toBe(0);
    expect(clampHandle("end", 5_000, { startMs: 10_000, endMs: 40_000 }, view)).toBe(11_000);
    expect(clampHandle("end", 200_000, { startMs: 10_000, endMs: 40_000 }, view)).toBe(100_000);
  });
});

describe("cutPoints", () => {
  // words 0–0.9 s, 1–1.9 s (sentence end), pause, 5–5.9 s; video 10 s
  const b: Boundary[] = [
    { afterWordEndMs: 0, beforeWordStartMs: 0 },
    { afterWordEndMs: 1_900, beforeWordStartMs: 5_000 },
    { afterWordEndMs: 5_900, beforeWordStartMs: 10_000 },
  ];

  it("gives the cut positions snapRange produces, as plain numbers, inside the window", () => {
    expect(cutPoints(b, 0, 10_000)).toEqual({ starts: [0, 4_850], ends: [2_050, 6_050] });
    expect(cutPoints(b, 3_000, 10_000)).toEqual({ starts: [4_850], ends: [6_050] });
  });
});
