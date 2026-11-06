import { describe, expect, it } from "vitest";
import { stepDone, stepHref } from "./stepLinks";

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

describe("stepDone", () => {
  const none = { hasClips: false, allReadyRendered: false };
  it("steps up to Briefing are done once the session is past them", () => {
    for (const step of ["Upload", "Processing", "Context", "Briefing"] as const) expect(stepDone(step, none)).toBe(true);
  });
  it("Prepare is done only when the session has clips", () => {
    expect(stepDone("Prepare", none)).toBe(false);
    expect(stepDone("Prepare", { hasClips: true, allReadyRendered: false })).toBe(true);
  });
  it("Export is done only when every ready clip is rendered", () => {
    expect(stepDone("Export", { hasClips: true, allReadyRendered: false })).toBe(false);
    expect(stepDone("Export", { hasClips: true, allReadyRendered: true })).toBe(true);
    expect(stepDone("Export", { hasClips: false, allReadyRendered: true })).toBe(false);
  });
});
