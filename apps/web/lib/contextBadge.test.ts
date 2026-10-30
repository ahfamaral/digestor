import { describe, expect, it } from "vitest";
import { factBadge, profileBadge } from "./contextBadge";

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
});
