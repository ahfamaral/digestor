import { describe, expect, it, vi } from "vitest";
import type { ContextCard, Fact, Moment, Topic, Word } from "@digestor/core";
import { groundBriefing, writeBriefing } from "./briefing.js";
import { FakeLLM, type StructuredLLM } from "../llm/structured.js";
import { MissingApiKeyError } from "../errors.js";

const none: Fact = { value: null, source: null, evidence: null };
const card: ContextCard = {
  language: none,
  profile: { value: "parliament", confidence: 0.9, evidence: "x" },
  title: none,
  summary: "A session.",
  setting: none,
  dateOrYear: none,
  participants: [],
  sufficient: true,
  openQuestions: [],
};
const text = "Every euro cut here costs three later, and we all know it.".split(" ");
const words: Word[] = text.map((t, i) => ({ text: t, startMs: i * 500, endMs: i * 500 + 400, speaker: "A", confidence: 1 }));
const topic = (idx: number): Topic => ({ id: `t${idx}`, analysisId: "a", idx, startMs: idx * 10_000, endMs: (idx + 1) * 10_000, title: `T${idx}`, summary: "" });
const topics = [topic(0), topic(1)];
const moment = (id: string, topicId: string): Moment => ({
  id, analysisId: "a", topicId, granularity: "passage", startMs: 0, endMs: 5000, title: id, why: "Because.", relevance: 80,
  speakers: ["A"], insideMomentId: null, evidence: [], checks: null, thumbKey: null, ownerId: null, origin: "ai",
});
const moments = [moment("m1", "t0"), moment("m2", "t1")];

describe("groundBriefing", () => {
  it("drops non-verbatim quotes and unsupported sentences", () => {
    const out = groundBriefing(
      {
        lead: [
          { text: "Budget fight.", momentIds: ["m1", "ghost"] },
          { text: "Invented.", momentIds: ["nope"] },
        ],
        sections: [
          { topicIdx: 0, summary: [{ text: "Cuts debated.", momentIds: ["m1"] }], keyQuote: { momentId: "m1", text: "Every euro cut here costs three later" } },
          { topicIdx: 1, summary: [{ text: "More.", momentIds: ["m2"] }], keyQuote: { momentId: "m2", text: "Cuts are very expensive in the long run" } },
          { topicIdx: 9, summary: [{ text: "Nowhere.", momentIds: ["m1"] }], keyQuote: null },
        ],
      },
      { moments, topics, words },
    );
    expect(out.lead).toEqual([{ text: "Budget fight.", momentIds: ["m1"] }]);
    expect(out.sections).toHaveLength(2);
    expect(out.sections[0]).toMatchObject({ topicId: "t0", keyQuote: { momentId: "m1" } });
    expect(out.sections[1]).toMatchObject({ topicId: "t1", keyQuote: null });
  });

  it("matches quotes ignoring case and punctuation", () => {
    const out = groundBriefing(
      { lead: [], sections: [{ topicIdx: 0, summary: [], keyQuote: { momentId: "m1", text: "\"every EURO cut here, costs three later\"" } }] },
      { moments, topics, words },
    );
    expect(out.sections[0]!.keyQuote).not.toBeNull();
  });
});

describe("writeBriefing", () => {
  it("returns an empty briefing when the call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await writeBriefing(new FakeLLM([]), { card, topics, moments, words });
    expect(out).toEqual({ lead: [], sections: [] });
  });

  it("lets a missing API key propagate", async () => {
    const llm: StructuredLLM = {
      generate: async () => {
        throw new MissingApiKeyError("ANTHROPIC_API_KEY");
      },
    };
    await expect(writeBriefing(llm, { card, topics, moments, words })).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("grounds a successful response and sends ids and excerpts in the prompt", async () => {
    const fake = new FakeLLM([{ lead: [{ text: "Hi.", momentIds: ["m1"] }], sections: [] }]);
    const out = await writeBriefing(fake, { card, topics, moments, words });
    expect(out.lead).toHaveLength(1);
    expect(fake.calls[0]!.name).toBe("briefing");
    expect(fake.calls[0]!.model).toBe("reasoning");
    expect(fake.calls[0]!.user).toContain("id=m1");
    expect(fake.calls[0]!.user).toContain("Every euro cut");
  });
});
