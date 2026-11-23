import { describe, expect, it } from "vitest";
import { LONG_BRIEFING, allTopics, topicOpen } from "./topicOpen";

describe("topicOpen", () => {
  it("is open on a short Briefing and closed on a long one, unless the reader chose", () => {
    expect(topicOpen("t1", {}, LONG_BRIEFING)).toBe(true);
    expect(topicOpen("t1", {}, LONG_BRIEFING + 1)).toBe(false);
    expect(topicOpen("t1", { t1: true }, 200)).toBe(true);
    expect(topicOpen("t1", { t1: false }, 3)).toBe(false);
  });
  it("Open all / Close all set every topic", () => {
    expect(allTopics(["a", "outside"], false)).toEqual({ a: false, outside: false });
  });
});
