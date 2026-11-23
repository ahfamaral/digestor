import { describe, expect, it } from "vitest";
import { SUBTITLE_GEOMETRY, SUBTITLE_STYLES, SubtitlePositionSchema, SubtitleStyleSchema, defaultSubtitlePosition } from "./subtitleStyle.ts";

describe("subtitle style and position", () => {
  it("positions default by profile", () => {
    for (const p of ["parliament", "supreme_court", "trial", "un"] as const) expect(defaultSubtitlePosition(p)).toBe("above_banner");
    for (const p of ["interview", "electoral_debate", "other"] as const) expect(defaultSubtitlePosition(p)).toBe("bottom");
  });
  it("has the agreed values", () => {
    expect(SubtitleStyleSchema.options).toEqual(["yellow", "white", "white_box", "yellow_box"]);
    expect(SubtitlePositionSchema.options).toEqual(["bottom", "above_banner", "top"]);
    expect(SUBTITLE_STYLES.yellow).toEqual({ color: "#FFE600", bold: true, box: false });
    expect(SUBTITLE_STYLES.white_box).toEqual({ color: "#FFFFFF", bold: false, box: true });
    expect(SUBTITLE_STYLES.yellow_box).toEqual({ color: "#FFE600", bold: false, box: true });
    expect(SUBTITLE_GEOMETRY.marginPct.above_banner).toBe(0.22);
    expect(SUBTITLE_GEOMETRY.fontPct).toEqual({ "16:9": 0.055, "9:16": 0.04 });
    expect(SUBTITLE_GEOMETRY.maxChars["16:9"]).toBe(42);
    expect(SUBTITLE_GEOMETRY.maxChars["9:16"]).toBe(24);
  });
});
