import { describe, expect, it } from "vitest";
import type { ContextCard, Fact, Word } from "@digestor/core";
import { checkMoment } from "./checks.js";
import { FakeLLM } from "../llm/structured.js";
import { MissingApiKeyError } from "../errors.js";

const none: Fact = { value: null, source: null, evidence: null };
const card: ContextCard = {
  language: none,
  profile: { value: "interview", confidence: 0.9, evidence: "x" },
  title: none,
  summary: "A session.",
  setting: none,
  dateOrYear: none,
  participants: [],
  sufficient: true,
  openQuestions: [],
};
const sentences = [
  "Zero one.", "One two.", "Two three.", "Three four.", "Four five.", "Five six.", "Six seven.", "Seven eight.",
];
// each sentence = 2 words, 1 s each, sentence k spans [k*2000, k*2000+2000)
const words: Word[] = sentences.flatMap((s, k) =>
  s.split(" ").map((t, j) => ({ text: t, startMs: k * 2000 + j * 1000, endMs: k * 2000 + j * 1000 + 900, speaker: "A", confidence: 1 })),
);
// moment = sentences 3..4 -> [6000, 10000)
const moment = { startMs: 6000, endMs: 10000, title: "The middle" };
const base = { argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false };

describe("checkMoment", () => {
  it("continuesWith comes from the transcript, not the model", async () => {
    const llm = new FakeLLM([{ ...base, argumentComplete: false, continuesWith: "made up" }]);
    const r = await checkMoment(llm, { card, moment, words });
    expect(r.argumentComplete).toBe(false);
    expect(r.continuesWith).toBe("Five six.");
  });

  it("complete argument has no continuation", async () => {
    const llm = new FakeLLM([{ ...base, continuesWith: "something" }]);
    expect((await checkMoment(llm, { card, moment, words })).continuesWith).toBeNull();
  });

  it("empty contextRisk becomes null", async () => {
    const a = await checkMoment(new FakeLLM([{ ...base, contextRisk: "   " }]), { card, moment, words });
    expect(a.contextRisk).toBeNull();
    const b = await checkMoment(new FakeLLM([{ ...base, contextRisk: "  Sounds like a quote. " }]), { card, moment, words });
    expect(b.contextRisk).toBe("Sounds like a quote.");
  });

  it("prompt includes the sentences before and after", async () => {
    const llm = new FakeLLM([base]);
    await checkMoment(llm, { card, moment, words });
    const user = llm.calls[0]!.user;
    expect(user).toContain("One two.");
    expect(user).toContain("Two three.");
    expect(user).not.toContain("Zero one.");
    expect(user).toContain("Five six.");
    expect(user).toContain("Seven eight.");
    expect(llm.calls[0]!.name).toBe("checks");
    expect(llm.calls[0]!.model).toBe("fast");
  });

  it("does not continue when there is nothing after the moment", async () => {
    const llm = new FakeLLM([{ ...base, argumentComplete: false }]);
    const r = await checkMoment(llm, { card, moment: { ...moment, endMs: 16000 }, words });
    expect(r.continuesWith).toBeNull();
  });

  it("lets errors propagate", async () => {
    const llm = { generate: async () => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); } };
    await expect(checkMoment(llm, { card, moment, words })).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});
