import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLOR_TOKENS as C, contrastRatio } from "./contrast";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("contrastRatio", () => {
  it("matches known values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });
});

describe("AA contrast (4.5:1) of the real colours", () => {
  it("brand fill vs its text", () => expect(contrastRatio(C.brand, C.brandForeground)).toBeGreaterThanOrEqual(4.5));
  it("muted text on the page background and on white", () => {
    expect(contrastRatio(C.mutedForeground, C.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(C.mutedForeground, C.white)).toBeGreaterThanOrEqual(4.5);
  });
  it("upcoming stepper text on white", () => expect(contrastRatio(C.stepUpcoming, C.white)).toBeGreaterThanOrEqual(4.5));
  it("done-step green on white", () => expect(contrastRatio(C.stepDone, C.white)).toBeGreaterThanOrEqual(4.5));
  it("disabled button text on its grey", () => expect(contrastRatio(C.disabledFg, C.disabledBg)).toBeGreaterThanOrEqual(4.5));
});

describe("focus ring (3:1, WCAG 1.4.11 and 2.4.13)", () => {
  it("on white and on the page background", () => {
    expect(contrastRatio(C.ring, C.white)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(C.ring, C.background)).toBeGreaterThanOrEqual(3);
  });
  it("is never drawn at half strength", () => expect(css).not.toMatch(/ring-ring\/50|outline-ring\/50/));
});

describe("globals.css uses the tested values", () => {
  const cssVars: Record<string, string> = {
    "--background": C.background,
    "--muted-foreground": C.mutedForeground,
    "--brand": C.brand,
    "--brand-foreground": C.brandForeground,
    "--step-upcoming": C.stepUpcoming,
    "--step-done": C.stepDone,
    "--disabled": C.disabledBg,
    "--disabled-foreground": C.disabledFg,
    "--ring": C.ring,
  };
  for (const [name, hex] of Object.entries(cssVars)) {
    it(`${name} is ${hex}`, () => {
      const root = css.slice(0, css.indexOf(".dark {"));
      expect(root).toMatch(new RegExp(`${name}:\\s*${hex};`, "i"));
    });
  }
});
