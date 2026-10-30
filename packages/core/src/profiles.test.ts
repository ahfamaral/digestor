import { describe, expect, it } from "vitest";
import { GRANULARITY, HIGHLIGHT_TYPES, LANGUAGES, PROFILES, ProfileIdSchema } from "./profiles.ts";

describe("profiles", () => {
  it("every profile lists only known highlight types", () => {
    for (const id of ProfileIdSchema.options) {
      expect(PROFILES[id].highlightTypes.length).toBeGreaterThan(0);
      for (const t of PROFILES[id].highlightTypes) expect(HIGHLIGHT_TYPES).toHaveProperty(t);
      expect(PROFILES[id].rubric.length).toBeGreaterThan(40);
    }
  });
  it("profile → highlight types match the spec", () => {
    expect(PROFILES.parliament.highlightTypes).toEqual(["heated", "strong_argument", "longest_speech", "laughter"]);
    expect(PROFILES.supreme_court.highlightTypes).toEqual(["vote", "divergence", "review_request", "clash", "result"]);
    expect(PROFILES.electoral_debate.highlightTypes).toEqual(["attack_rebuttal", "promise", "dodge", "zinger", "claim_to_check"]);
    expect(PROFILES.trial.highlightTypes).toEqual(["key_testimony", "objection_ruling", "contradiction", "emotional"]);
    expect(PROFILES.interview.highlightTypes).toEqual(["news_line", "quotable", "dodge", "emotional", "heated", "key_point", "light"]);
    expect(PROFILES.un.highlightTypes).toEqual(["strong_statement", "explanation_of_vote", "right_of_reply", "walkout"]);
    expect(PROFILES.other.highlightTypes).toEqual(["heated", "key_point", "light"]);
    expect(PROFILES.trial.sensitive).toBe(true);
    for (const id of ProfileIdSchema.options) if (id !== "trial") expect(PROFILES[id].sensitive).toBe(false);
  });
  it("only longest_speech is counted", () => {
    const counted = Object.entries(HIGHLIGHT_TYPES).filter(([, t]) => t.method === "counted").map(([id]) => id);
    expect(counted).toEqual(["longest_speech"]);
  });
  it("tones are distinct within each profile", () => {
    for (const id of ProfileIdSchema.options) {
      const tones = PROFILES[id].highlightTypes.map((t) => HIGHLIGHT_TYPES[t].tone);
      expect(new Set(tones).size).toBe(tones.length);
    }
  });
  it("card labels", () => {
    expect(HIGHLIGHT_TYPES.heated.cardLabel).toBe("Most heated");
    expect(HIGHLIGHT_TYPES.longest_speech.cardLabel).toBe("Longest speech");
  });
  it("granularity ranges", () => {
    expect(GRANULARITY.exchange.acceptMs).toEqual([60_000, 1_200_000]);
    expect(GRANULARITY.passage.acceptMs).toEqual([20_000, 150_000]);
    expect(GRANULARITY.punchline.acceptMs).toEqual([6_000, 45_000]);
  });
  it("offers 13 languages starting with English", () => {
    expect(LANGUAGES).toHaveLength(13);
    expect(LANGUAGES[0]).toEqual({ code: "en", label: "English" });
  });
});
