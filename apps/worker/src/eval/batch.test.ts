import { describe, expect, it } from "vitest";
import type { MomentChecks } from "@digestor/core";
import { checkScores, fmtSpread, pickControls, spread } from "./batch.js";

const ok: MomentChecks = { argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, interpreter: false, reportedSpeech: false };
const span = (startMs: number, endMs: number) => ({ startMs, endMs });

describe("spread / fmtSpread", () => {
  it("summarises the runs that produced a value and formats mean (min–max)", () => {
    const s = spread([10, null, 14, 12]);
    expect(s).toEqual({ mean: 12, min: 10, max: 14, n: 3 });
    expect(fmtSpread(s)).toBe("12.0 (10.0–14.0)");
    expect(fmtSpread(spread([0.5]), 2, " s")).toBe("0.50 s");
    expect(fmtSpread(spread([null]))).toBe("n/a");
  });
});

describe("pickControls", () => {
  it("keeps only moments clear of every trap, spread evenly over the video", () => {
    const moments = Array.from({ length: 10 }, (_, i) => span(i * 1000, i * 1000 + 500));
    const traps = [span(2100, 2200), span(7000, 7100)];
    const picked = pickControls(moments, traps, 4);
    expect(picked).toHaveLength(4);
    expect(picked.some((m) => m.startMs === 2000 || m.startMs === 7000)).toBe(false);
    expect(picked.map((m) => m.startMs)).toEqual([0, 3000, 5000, 8000]);
    expect(pickControls(moments, traps, 50)).toHaveLength(8);
  });
});

describe("checkScores", () => {
  it("counts traps fired, warnings on trap moments and on controls, per kind", () => {
    const traps = [
      { kind: "quoted_opponent" as const, ...span(0, 100) },
      { kind: "quoted_opponent" as const, ...span(1000, 1100) },
      { kind: "mid_argument" as const, ...span(5000, 5100) },
    ];
    const quoted = { ...ok, reportedSpeech: true };
    const cut = { ...ok, argumentComplete: false };
    const checked = [
      { ...span(0, 200), checks: quoted }, // fires trap 1
      { ...span(50, 150), checks: ok }, // on trap 1, no warning
      { ...span(1000, 1200), checks: null }, // trap 2 unchecked: not fired
      { ...span(5000, 5200), checks: cut }, // fires the mid-argument trap
    ];
    const controls = [{ ...span(9000, 9100), checks: quoted }, { ...span(9500, 9600), checks: ok }, { ...span(9700, 9800), checks: null }];
    const r = checkScores(traps, checked, controls);
    expect(r.quoted_opponent).toEqual({ trapsFired: 1, traps: 2, trapMomentsWarned: 1, trapMoments: 2, controlsWarned: 1, controls: 2 });
    expect(r.mid_argument).toEqual({ trapsFired: 1, traps: 1, trapMomentsWarned: 1, trapMoments: 1, controlsWarned: 0, controls: 2 });
  });
});
