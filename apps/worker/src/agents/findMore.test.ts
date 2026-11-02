import { describe, expect, it } from "vitest";
import type { Attribution, ContextCard, Fact, Topic, Transcript, Word } from "@digestor/core";
import { FIND_MORE_MAX_CHARS, MAX_FIND_MORE_MOMENTS, findMoreMoments, personTurnRanges } from "./findMore.js";
import { FakeLLM } from "../llm/structured.js";

const S = 1000;
const MIN = 60 * S;
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
const ts = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
/** One sentence-ending word per second, `w<second>.`; speaker A until `switchAtS`, then B. */
function transcript(durationS: number, switchAtS = Infinity): Transcript {
  const words: Word[] = Array.from({ length: durationS }, (_, i) => ({
    text: `w${i}.`, startMs: i * S, endMs: i * S + 500, speaker: i < switchAtS ? "A" : "B", confidence: 0.99,
  }));
  return { words, durationMs: durationS * S, language: "en", languageConfidence: 0.99 };
}
const topics: Topic[] = [{ id: "t1", analysisId: "an", idx: 0, startMs: 0, endMs: 40 * MIN, title: "T", summary: "" }];
const lm = (a: number, b: number, o: Record<string, unknown> = {}) => ({
  title: `M${a}`, why: "Because.", highlightTypes: ["heated"], relevance: 70, granularity: "passage", start: ts(a), end: ts(b), evidence: ["w"], ...o,
});

describe("findMoreMoments", () => {
  it("sends only the person's turns with 30 s around them, capped", async () => {
    const llm = new FakeLLM([{ moments: [] }]);
    const t = transcript(40 * 60);
    await findMoreMoments(llm, { card, transcript: t, topics, personTurns: [{ startMs: 600 * S, endMs: 660 * S }], personName: "Tralli" });
    expect(llm.calls).toHaveLength(1);
    const { user, model, name } = llm.calls[0]!;
    expect(model).toBe("reasoning");
    expect(name).toBe("find_more");
    expect(user).toContain("Focus person: Tralli");
    expect(user).toContain("Tralli: w620.");
    expect(user).toContain("w580."); // 30 s of context before
    expect(user).toContain("w680."); // and after
    expect(user).not.toContain("w560.");
    expect(user).not.toContain("w700.");
    expect(user).not.toContain("w2000.");
  });

  it("keeps a 3-hour person under FIND_MORE_MAX_CHARS", async () => {
    const llm = new FakeLLM([{ moments: [] }]);
    const t = transcript(3 * 3600);
    await findMoreMoments(llm, { card, transcript: t, topics, personTurns: [{ startMs: 0, endMs: t.durationMs }], personName: "Tralli" });
    const { system, user } = llm.calls[0]!;
    expect(user.length).toBeGreaterThan(100_000);
    expect(user.length).toBeLessThanOrEqual(FIND_MORE_MAX_CHARS);
    expect(system.length + user.length).toBeLessThan(FIND_MORE_MAX_CHARS + 20_000);
  });

  it("drops moments where the person speaks under 3 s and keeps at most 20", async () => {
    const t = transcript(40 * 60, 1500);
    const turns = [{ startMs: 0, endMs: 1500 * S }];
    const good = Array.from({ length: 30 }, (_, i) => lm(i * 45 * S, i * 45 * S + 40 * S, { relevance: 50 + i }));
    const edge = lm(1498 * S, 1538 * S, { title: "edge", relevance: 99 }); // 2 s of the person
    const away = lm(2000 * S, 2040 * S, { title: "away", relevance: 99 });
    const llm = new FakeLLM([{ moments: [...good, edge, away] }]);
    const out = await findMoreMoments(llm, { card, transcript: t, topics, personTurns: turns, personName: "Tralli" });
    expect(out).toHaveLength(MAX_FIND_MORE_MOMENTS);
    expect(out.map((m) => m.title)).not.toContain("edge");
    expect(out.map((m) => m.title)).not.toContain("away");
    expect(out[0]).toMatchObject({ origin: "find_more", granularity: "passage", topicId: "t1", speakers: ["A"] });
    expect(out[0]!.highlights).toEqual([{ type: "heated", method: "ai", value: null }]);
    expect(Math.max(...out.map((m) => m.relevance))).toBe(79); // the best 20 by relevance
  });

  it("drops a draft that repeats a moment already shown (same granularity, overlap over 0.6)", async () => {
    const t = transcript(40 * 60, 1500);
    const llm = new FakeLLM([{ moments: [lm(100 * S, 140 * S, { title: "dup" }), lm(300 * S, 340 * S, { title: "new" }), lm(100 * S, 140 * S, { title: "other level", granularity: "exchange", start: ts(100 * S), end: ts(200 * S) })] }]);
    const out = await findMoreMoments(llm, {
      card, transcript: t, topics, personTurns: [{ startMs: 0, endMs: 1500 * S }], personName: "Tralli",
      existing: [{ granularity: "passage", startMs: 105 * S, endMs: 140 * S }],
    });
    expect(out.map((m) => m.title).sort()).toEqual(["new", "other level"]);
  });

  it("makes no call when the person has no turns", async () => {
    const llm = new FakeLLM([]);
    expect(await findMoreMoments(llm, { card, transcript: transcript(600), topics, personTurns: [], personName: "X" })).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("personTurnRanges", () => {
  const att = (speakerId: string, personId: string, status: Attribution["status"]): Attribution => ({
    id: speakerId, sessionId: "s", speakerId, startMs: null, endMs: null, personId, source: "transcript", status, confidence: 0.7,
    evidence: { kind: "none" }, createdBy: "t", createdAt: new Date(), supersededAt: null,
  });
  const words = transcript(10, 4).words; // A: 0-3, B: 4-9
  it("runs of words that resolve to the person", () => {
    expect(personTurnRanges(words, [att("A", "p1", "proposed")], "p1", false)).toEqual([{ startMs: 0, endMs: 3500 }]);
    expect(personTurnRanges(words, [att("A", "p1", "proposed")], "p2", false)).toEqual([]);
  });
  it("sensitive profiles ignore an unconfirmed name", () => {
    expect(personTurnRanges(words, [att("A", "p1", "proposed")], "p1", true)).toEqual([]);
    expect(personTurnRanges(words, [{ ...att("A", "p1", "confirmed"), source: "human" }], "p1", true)).toHaveLength(1);
  });
});
