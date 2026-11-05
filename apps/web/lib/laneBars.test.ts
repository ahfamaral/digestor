import { describe, expect, it } from "vitest";
import type { MomentWithHighlights } from "@digestor/core";
import type { MomentView } from "./briefingFilters";
import { laneBars } from "./laneBars";

const topic = { startMs: 100_000, endMs: 160_000 };
function view(id: string, startS: number, endS: number, types: string[] = [], status: MomentView["status"] = null): MomentView {
  const moment = {
    id, analysisId: "a", topicId: "t", granularity: "passage", startMs: startS * 1000, endMs: endS * 1000, title: id, why: "w",
    relevance: 50, speakers: ["A"], insideMomentId: null, evidence: [], checks: null, thumbKey: null, ownerId: null, origin: "ai",
    highlights: types.map((type) => ({ type, method: "ai", value: null })),
  } as unknown as MomentWithHighlights;
  return { moment, status, children: [] };
}

describe("laneBars", () => {
  it("positions bars as percentages of the topic span", () => {
    const [b] = laneBars([view("m", 115, 130)], topic);
    expect(b).toMatchObject({ id: "m", level: "passage", leftPct: 25, widthPct: 25, approved: false });
  });
  it("takes the tone from the first highlight, null without highlights", () => {
    const [a, b] = laneBars([view("a", 100, 110, ["quotable"]), view("b", 100, 110)], topic);
    expect(a!.tone).not.toBeNull();
    expect(b!.tone).toBeNull();
  });
  it("clamps a moment that overhangs the topic and keeps a minimum width", () => {
    const [over, tiny, before] = laneBars([view("o", 150, 200), view("t", 120, 120.1), view("b", 90, 110)], topic);
    expect(over!.leftPct + over!.widthPct).toBeCloseTo(100);
    expect(tiny!.widthPct).toBe(0.8);
    expect(before!.leftPct).toBe(0);
    expect(before!.widthPct).toBeCloseTo((10 / 60) * 100);
  });
  it("marks approved moments", () => {
    expect(laneBars([view("m", 100, 110, [], "approved")], topic)[0]!.approved).toBe(true);
  });
});
