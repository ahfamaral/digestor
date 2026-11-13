import { describe, expect, it } from "vitest";
import { NOT_IN_DATA } from "../agents/ask.js";
import { answerScores, parseCitations, retrievalScores, type AskGoldenQuestion } from "./askMetrics.js";

const q = (id: string, answerable: boolean, expect: { startMs: number; endMs: number }[], quote?: string): AskGoldenQuestion => ({
  id,
  question: id,
  answerable,
  expect,
  ...(quote ? { quote } : {}),
});

describe("retrievalScores", () => {
  it("recall and MRR over answerable questions; an overlap counts, unanswerable ones are skipped", () => {
    const qs = [q("a", true, [{ startMs: 10_000, endMs: 20_000 }]), q("b", true, [{ startMs: 500_000, endMs: 510_000 }]), q("c", false, [])];
    const hits = new Map([
      ["a", [{ startMs: 15_000, endMs: 60_000 }]],
      ["b", [{ startMs: 0, endMs: 45_000 }, { startMs: 100_000, endMs: 145_000 }]],
      ["c", [{ startMs: 0, endMs: 45_000 }]],
    ]);
    expect(retrievalScores(qs, hits, 6)).toEqual({ recallAtK: 0.5, mrr: 0.5, n: 2 });
  });
  it("MRR 0.75 for first hits at ranks 1 and 2, and only ranks inside k count", () => {
    const qs = [q("a", true, [{ startMs: 0, endMs: 10 }]), q("b", true, [{ startMs: 100, endMs: 110 }])];
    const hits = new Map([
      ["a", [{ startMs: 0, endMs: 10 }]],
      ["b", [{ startMs: 500, endMs: 600 }, { startMs: 100, endMs: 110 }, { startMs: 100, endMs: 110 }]],
    ]);
    expect(retrievalScores(qs, hits, 6)).toEqual({ recallAtK: 1, mrr: 0.75, n: 2 });
    expect(retrievalScores(qs, hits, 1)).toEqual({ recallAtK: 0.5, mrr: 0.5, n: 2 });
  });
  it("empty input is 0", () => {
    expect(retrievalScores([], new Map(), 6)).toEqual({ recallAtK: 0, mrr: 0, n: 0 });
  });
});

describe("answerScores", () => {
  const span = [{ startMs: 100_000, endMs: 110_000 }];
  const row = (qq: AskGoldenQuestion, answer: string, citedMs: number[], quotesFound: boolean[] = []) => ({ q: qq, answer, citedMs, quotesFound });
  it("a citation within 30 s of an expected span counts, 31 s does not", () => {
    const qq = q("a", true, span);
    expect(answerScores([row(qq, "x", [140_000])]).citationHit).toBe(1);
    expect(answerScores([row(qq, "x", [141_000])]).citationHit).toBe(0);
    expect(answerScores([row(qq, "x", [69_999])]).citationHit).toBe(0);
    expect(answerScores([row(qq, "x", [70_000])]).citationHit).toBe(1);
  });
  it("quote exact is the share of answers with quotes whose quotes all appear in the transcript", () => {
    const qq = q("a", true, span);
    const s = answerScores([row(qq, "x", [], [true, true]), row(qq, "x", [], [true, false]), row(qq, "x", [])]);
    expect(s.quoteExact).toBe(0.5);
  });
  it("refusal: an unanswerable question answered with NOT_IN_DATA or I couldn't confirm", () => {
    const u = q("u", false, []);
    expect(answerScores([row(u, NOT_IN_DATA, [])]).refusalCorrect).toBe(1);
    expect(answerScores([row(u, "I couldn't confirm: nothing", [])]).refusalCorrect).toBe(1);
    expect(answerScores([row(u, "He said so at [00:01:00].", [60_000])]).refusalCorrect).toBe(0);
  });
  it("a refusal whose first word the model translated still counts; giving up on the step limit does not", () => {
    const u = q("u", false, []);
    expect(answerScores([row(u, "Das isn't in this video's data.", [])]).refusalCorrect).toBe(1);
    expect(answerScores([row(u, "I couldn't finish looking this up within my step limit. Please ask a narrower question.", [])]).refusalCorrect).toBe(0);
  });
  it("counts n and ignores unanswerable questions for citation hit", () => {
    const s = answerScores([row(q("a", true, span), "x", [100_000]), row(q("u", false, []), NOT_IN_DATA, [])]);
    expect(s).toEqual({ citationHit: 1, quoteExact: 0, refusalCorrect: 1, n: 2 });
  });
});

describe("parseCitations", () => {
  it("reads [hh:mm:ss] and [mm:ss] and quoted text", () => {
    const r = parseCitations('He said "wir schaffen das" at [00:01:05] and [1:02:03].');
    expect(r.citedMs).toEqual([65_000, 3_723_000]);
    expect(r.quotes).toEqual(["wir schaffen das"]);
  });
  it("reads both ends of a cited range, with an en dash or a hyphen, and several times in one bracket", () => {
    const r = parseCitations("Yes [00:11:37–00:12:26] and [01:03:22-01:04:00] and [00:00:05; 00:00:09].");
    expect(r.citedMs).toEqual([697_000, 746_000, 3_802_000, 3_840_000, 5_000, 9_000]);
  });
});
