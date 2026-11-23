import { describe, expect, it } from "vitest";
import { pageTitle, sessionScreenName } from "./pageTitle";

describe("pageTitle", () => {
  it("names the page first and ends with Digestor, skipping empty parts", () => {
    expect(pageTitle("Debate", "Briefing")).toBe("Debate · Briefing · Digestor");
    expect(pageTitle(null, " ", "Sessions")).toBe("Sessions · Digestor");
  });
  it("names the screen a session shows", () => {
    expect(sessionScreenName("ready")).toBe("Briefing");
    expect(sessionScreenName("awaiting_context")).toBe("Context");
    expect(sessionScreenName("transcribing")).toBe("Processing");
  });
});
