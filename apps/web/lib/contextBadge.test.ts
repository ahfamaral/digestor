import { describe, expect, it } from "vitest";
import { factBadge, profileBadge, shownBadge } from "./contextBadge";

describe("context badges", () => {
  it("profile is suggested by AI until edited, then from you", () => {
    expect(profileBadge("interview", "interview")).toBe("ai");
    expect(profileBadge("trial", "interview")).toBe("human");
  });
  it("facts show their own source, from you when edited, missing when empty", () => {
    const fact = { value: "x", source: "metadata" as const, evidence: null };
    expect(factBadge(fact, "x", "x")).toBe("metadata");
    expect(factBadge(fact, "y", "x")).toBe("human");
    expect(factBadge(fact, "", "x")).toBe("missing");
    expect(factBadge({ value: null, source: null, evidence: null }, "", "")).toBe("missing");
  });
  it("a date filled in from the official record reads from record until the journalist changes it", () => {
    const empty = { value: null, source: null, evidence: null };
    expect(factBadge(empty, "2026-10-21", "", "2026-10-21")).toBe("record");
    expect(factBadge(empty, "2026-10-22", "", "2026-10-21")).toBe("human");
    expect(factBadge(empty, "", "", "2026-10-21")).toBe("missing");
    // a stored date keeps its own source even when it equals the record's
    expect(factBadge({ value: "2026-10-21", source: "metadata", evidence: null }, "2026-10-21", "2026-10-21", "2026-10-21")).toBe("metadata");
  });
  it("a fact from the recording reads from audio for an audio-only file; other sources keep theirs", () => {
    expect(shownBadge("video", true)).toBe("audio");
    expect(shownBadge("video", false)).toBe("video");
    for (const k of ["metadata", "human", "missing", "ai", "record"] as const) expect(shownBadge(k, true)).toBe(k);
  });
});
