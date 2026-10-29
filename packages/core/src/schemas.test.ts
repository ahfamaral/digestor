import { describe, expect, it } from "vitest";
import { CandidateSchema, ContextCardSchema, EventTypeSchema } from "./schemas.js";
import { EVENT_TYPES } from "./eventTypes.js";
import { estimateCostUsd } from "./cost.js";

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
  eventType: { value: "interview", confidence: 0.8, evidence: null },
  title: nullFact,
  summary: "A talk.",
  setting: nullFact,
  dateOrYear: nullFact,
  participants: [],
  sufficient: false,
};
const cardWith4Questions = { ...baseCard, openQuestions: [1, 2, 3, 4].map(question) };
const validCandidate = {
  title: "A clash",
  reason: "They disagree sharply.",
  label: "heated",
  score: 80,
  start: "00:01:02",
  end: "00:03:04",
  evidence: ["quote"],
};

describe("schemas", () => {
  it("candidate keys keep reason before label and score", () => {
    expect(Object.keys(CandidateSchema.shape)).toEqual(
      ["title", "reason", "label", "score", "start", "end", "evidence"]);
  });
  it("accepts a valid candidate and card", () => {
    expect(CandidateSchema.safeParse(validCandidate).success).toBe(true);
    expect(ContextCardSchema.safeParse({ ...baseCard, openQuestions: [question(1)] }).success).toBe(true);
  });
  it("context card rejects more than 3 open questions", () => {
    expect(ContextCardSchema.safeParse(cardWith4Questions).success).toBe(false);
  });
  it("start must be hh:mm:ss", () => {
    expect(CandidateSchema.safeParse({ ...validCandidate, start: "1:2:3" }).success).toBe(false);
  });
  it("every event type has a rubric", () => {
    for (const t of EventTypeSchema.options) expect(EVENT_TYPES[t].rubric.length).toBeGreaterThan(40);
  });
  it("estimates cost per hour", () => { expect(estimateCostUsd(90 * 60_000)).toBe(0.6); });
});
