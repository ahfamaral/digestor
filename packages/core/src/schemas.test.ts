import { describe, expect, it } from "vitest";
import { ContextCardSchema, ResumePayloadSchema } from "./schemas.ts";

const nullFact = { value: null, source: null, evidence: null };
const question = (i: number) => ({
  id: `q${i}`,
  target: "other" as const,
  speakerId: null,
  question: "Who is speaking?",
  why: "Needed for labels",
  sampleStartMs: null,
});
const baseCard = {
  language: { value: "en", source: "video", evidence: null },
  profile: { value: "interview", confidence: 0.8, evidence: null },
  title: nullFact,
  summary: "A talk.",
  setting: nullFact,
  dateOrYear: nullFact,
  participants: [],
  sufficient: false,
};
const cardWith4Questions = { ...baseCard, openQuestions: [1, 2, 3, 4].map(question) };

describe("schemas", () => {
  it("accepts a valid card", () => {
    expect(ContextCardSchema.safeParse({ ...baseCard, openQuestions: [question(1)] }).success).toBe(true);
  });
  it("context card rejects more than 3 open questions", () => {
    expect(ContextCardSchema.safeParse(cardWith4Questions).success).toBe(false);
  });
  it("context card accepts supreme_court and rejects the old court id", () => {
    const card = (value: string) => ({ ...baseCard, profile: { value, confidence: 0.8, evidence: null }, openQuestions: [] });
    expect(ContextCardSchema.safeParse(card("supreme_court")).success).toBe(true);
    expect(ContextCardSchema.safeParse(card("court")).success).toBe(false);
  });
  it("resume payload rejects the removed render action and accepts profile and language edits", () => {
    expect(ResumePayloadSchema.safeParse({ action: "render" }).success).toBe(false);
    expect(
      ResumePayloadSchema.safeParse({ action: "continue", answers: [], cardEdits: { profile: "trial", language: "pt" } }).success,
    ).toBe(true);
  });
});
