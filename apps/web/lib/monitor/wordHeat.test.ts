import { describe, expect, it } from "vitest";
import { heatLevel, heatRow, yearMonths } from "./wordHeat";

describe("word heat", () => {
  it("levels: no text, not used, about as often (or less), more, much more", () => {
    expect(heatLevel(null)).toBe("none");
    expect(heatLevel(0)).toBe("unused");
    expect(heatLevel(0.4)).toBe("about");
    expect(heatLevel(1.49)).toBe("about");
    expect(heatLevel(1.5)).toBe("more");
    expect(heatLevel(5.99)).toBe("more");
    expect(heatLevel(6)).toBe("muchMore");
    expect(heatLevel(52)).toBe("muchMore");
    expect(heatLevel(Infinity)).toBe("muchMore"); // only this deputy said it that month
  });

  it("one cell per month of the year; months without a share are 'none'", () => {
    expect(yearMonths(2026)).toHaveLength(12);
    expect(yearMonths(2026)[0]).toBe("2026-01");
    expect(yearMonths(2026)[11]).toBe("2026-12");
    const row = heatRow([{ month: "2026-03", share: 7.8 }, { month: "2026-04", share: 0 }, { month: "2026-05", share: null }, { month: "2025-12", share: 9 }], 2026);
    expect(row.map((c) => c.level)).toEqual(["none", "none", "muchMore", "unused", "none", "none", "none", "none", "none", "none", "none", "none"]);
    // cells carry a level, never the number
    expect(Object.keys(row[2]!)).toEqual(["month", "level"]);
  });
});
