import { describe, expect, it } from "vitest";
import { currentSection } from "./sectionSpy";

describe("currentSection", () => {
  const tops = [{ id: "speeches", top: -900 }, { id: "words", top: -40 }, { id: "votes", top: 300 }];
  it("is the last section whose top passed the bar", () => expect(currentSection(tops, 60)).toBe("words"));
  it("is null above the first section", () => expect(currentSection([{ id: "a", top: 200 }], 60)).toBeNull());
  it("skips sections that aren't on the page", () => expect(currentSection([{ id: "a", top: -10 }, { id: "b", top: null }], 60)).toBe("a"));
  it("is the last section at the bottom of the page when it is in view", () => expect(currentSection(tops, 60, true)).toBe("votes"));
});
