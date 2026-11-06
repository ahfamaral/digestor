import { describe, expect, it } from "vitest";
import { stepHref } from "./stepLinks";

describe("stepHref", () => {
  it("links Briefing, Prepare and Export of a ready session", () => {
    const s = { id: "x", ready: true };
    expect(stepHref("Briefing", s)).toBe("/s/x");
    expect(stepHref("Prepare", s)).toBe("/s/x/prepare");
    expect(stepHref("Export", s)).toBe("/s/x/export");
    expect(stepHref("Upload", s)).toBeNull();
    expect(stepHref("Processing", s)).toBeNull();
    expect(stepHref("Context", s)).toBeNull();
  });
  it("links nothing before the session is ready", () => {
    for (const step of ["Upload", "Processing", "Context", "Briefing", "Prepare", "Export"] as const) {
      expect(stepHref(step, { id: "x", ready: false })).toBeNull();
    }
  });
});
