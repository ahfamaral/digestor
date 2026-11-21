import { describe, expect, it } from "vitest";
import type { Attribution, Person, Topic, Word } from "@digestor/core";
import { GENERIC_ASK_EXAMPLES, askExampleNames, askExamples, askExampleTopics, prepareAskExamples } from "./askExamples";

const w = (startS: number, speaker: string): Word => ({ text: "x", startMs: startS * 1000, endMs: startS * 1000 + 500, speaker, confidence: 0.9 });
const person = (id: string, displayName: string): Person => ({
  id, displayName, fullName: null, kind: "custom", party: null, state: null, role: null, photoUrl: null, officialIds: {},
});
const att = (o: Partial<Attribution>): Attribution => ({
  id: "a", sessionId: "s", speakerId: "A", startMs: null, endMs: null, personId: "P", source: "human", status: "confirmed",
  confidence: 1, evidence: { kind: "none" }, createdBy: "owner", createdAt: new Date(0), supersededAt: null, ...o,
});
const topic = (idx: number, title: string, startMs: number, endMs: number): Topic => ({ id: `t${idx}`, analysisId: "a", idx, startMs, endMs, title, summary: "" });

describe("askExampleNames", () => {
  // A speaks 4 words, B 3, C 2, D 1.
  const words = [...[0, 1, 2, 3].map((i) => w(i, "A")), ...[4, 5, 6].map((i) => w(i, "B")), w(7, "C"), w(8, "C"), w(9, "D")];
  const persons = [person("P", "Ana Silva"), person("Q", "Bia Lima"), person("R", "Caio Reis")];

  it("lists named people by speaking share", () => {
    const names = { persons, attributions: [att({ speakerId: "B", personId: "Q" }), att({ speakerId: "A", personId: "P" })] };
    expect(askExampleNames(names, words, false)).toEqual(["Ana Silva", "Bia Lima"]);
  });

  it("uses an AI-proposed name outside a sensitive profile, never inside one", () => {
    const names = {
      persons,
      attributions: [att({ speakerId: "A", personId: "P", source: "transcript", status: "proposed" }), att({ speakerId: "B", personId: "Q" })],
    };
    expect(askExampleNames(names, words, false)).toEqual(["Ana Silva", "Bia Lima"]);
    expect(askExampleNames(names, words, true)).toEqual(["Bia Lima"]);
  });

  it("never names a voice marked No name", () => {
    const names = {
      persons,
      attributions: [att({ speakerId: "A", personId: "P", source: "transcript", status: "proposed" }), att({ id: "h", speakerId: "A", personId: null, status: "anonymous" })],
    };
    expect(askExampleNames(names, words, false)).toEqual([]);
  });

  it("is empty without names", () => {
    expect(askExampleNames({ persons: [], attributions: [] }, words, false)).toEqual([]);
  });
});

describe("askExampleTopics", () => {
  it("takes the longest topics first, skipping titles too long for a question", () => {
    const topics = [topic(0, "Opening", 0, 60_000), topic(1, "Housing", 60_000, 600_000), topic(2, "x".repeat(61), 600_000, 2_000_000), topic(3, "  Public   transport ", 2_000_000, 2_300_000)];
    expect(askExampleTopics(topics)).toEqual(["Housing", "Public transport", "Opening"]);
  });
});

describe("askExamples", () => {
  it("builds questions from the session's topics and names", () => {
    expect(askExamples({ topics: ["Housing", "Transport"], names: ["Ana Silva", "Bia Lima"] })).toEqual([
      "What did Ana Silva say about “Housing”?",
      "Find the strongest quote about “Transport”.",
      "What were the main points Bia Lima made?",
    ]);
  });

  it("asks about a topic without names, and fills up with generic questions", () => {
    expect(askExamples({ topics: ["Housing"], names: [] })).toEqual([
      "What was said about “Housing”?",
      GENERIC_ASK_EXAMPLES[0],
      GENERIC_ASK_EXAMPLES[1],
    ]);
  });

  it("asks about a person without topics", () => {
    expect(askExamples({ topics: [], names: ["Ana Silva"] })).toEqual(["What were the main points Ana Silva made?", GENERIC_ASK_EXAMPLES[0], GENERIC_ASK_EXAMPLES[1]]);
  });

  it("falls back to generic examples without topics or names", () => {
    expect(askExamples({ topics: [], names: [] })).toEqual(GENERIC_ASK_EXAMPLES);
    expect(GENERIC_ASK_EXAMPLES).toHaveLength(3);
  });
});

describe("prepareAskExamples", () => {
  it("offers clip examples only when the session has clips", () => {
    expect(prepareAskExamples(2)).toEqual(["Make clip 1 shorter", "Include the question before clip 1", "Make clip 1 for Instagram with English subtitles"]);
    expect(prepareAskExamples(0)).toEqual(GENERIC_ASK_EXAMPLES);
    expect(prepareAskExamples(0).join(" ")).not.toMatch(/clip 1/);
  });
});
