import { describe, expect, it } from "vitest";
import { PROFILES, type Boundary, type ContextCard, type Fact, type Transcript, type Word } from "@digestor/core";
import { findTopics, normalizeTopics } from "./topics.js";
import { FakeLLM, type StructuredLLM } from "../llm/structured.js";
import { MissingApiKeyError } from "../errors.js";

const MIN = 60_000;
const none: Fact = { value: null, source: null, evidence: null };
const DURATION = 40 * MIN;
const boundaries: Boundary[] = Array.from({ length: DURATION / 1000 + 1 }, (_, i) => ({
  afterWordEndMs: i * 1000,
  beforeWordStartMs: i * 1000 + 100,
}));
const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const t = (title: string, a: number, b: number) => ({ title, summary: `About ${title}.`, start: mmss(a), end: mmss(b) });

function card(profile: ContextCard["profile"]["value"] = "parliament"): ContextCard {
  return {
    language: none,
    profile: { value: profile, confidence: 0.9, evidence: "x" },
    title: none,
    summary: "A session.",
    setting: none,
    dateOrYear: none,
    participants: [],
    sufficient: true,
    openQuestions: [],
  };
}
const words: Word[] = Array.from({ length: 40 }, (_, i) => ({
  text: i % 5 === 4 ? "word." : "word",
  startMs: i * 60_000,
  endMs: i * 60_000 + 500,
  speaker: "A",
  confidence: 0.99,
}));
const transcript: Transcript = { words, durationMs: DURATION, language: "en" } as unknown as Transcript;

describe("normalizeTopics", () => {
  it("repairs gaps, overlaps, tiny and too many topics", () => {
    const out = normalizeTopics(
      {
        topics: [
          t("C", 12 * MIN, 30 * MIN),
          t("A", 0, 5 * MIN),
          t("B", 4 * MIN, 10 * MIN),
          { title: "Bad", summary: "", start: "soon", end: "later" },
          t("Tiny", 39 * MIN + 20_000, 40 * MIN),
        ],
      },
      { durationMs: DURATION, boundaries },
    );
    expect(out.map((x) => x.title)).toEqual(["A", "B", "C"]);
    expect(out[0]!.startMs).toBe(0);
    for (let i = 1; i < out.length; i++) expect(out[i]!.startMs).toBe(out[i - 1]!.endMs);
    expect(out.at(-1)!.endMs).toBe(DURATION);
    for (const x of out) expect(x.endMs - x.startMs).toBeGreaterThanOrEqual(MIN);
  });

  it("caps at 30 topics, merging the shortest pairs and keeping the longer side's title", () => {
    const topics = Array.from({ length: 45 }, (_, i) => t(`T${i}`, i * 60_000, (i + 1) * 60_000));
    // T3 is long (3 min) so it should survive with its title: shift following starts.
    const raw = topics.map((x, i) => (i > 3 ? t(`T${i}`, (i + 2) * 60_000, (i + 3) * 60_000) : x));
    const out = normalizeTopics({ topics: raw }, { durationMs: 47 * MIN, boundaries: [{ afterWordEndMs: 0, beforeWordStartMs: 0 }, ...Array.from({ length: 47 * 60 }, (_, i) => ({ afterWordEndMs: (i + 1) * 1000, beforeWordStartMs: (i + 1) * 1000 + 100 }))] });
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.map((x) => x.title)).toContain("T3");
    expect(out[0]!.startMs).toBe(0);
    expect(out.at(-1)!.endMs).toBe(47 * MIN);
    for (let i = 1; i < out.length; i++) expect(out[i]!.startMs).toBe(out[i - 1]!.endMs);
  });
});

describe("findTopics", () => {
  it("falls back to one whole-session topic when nothing is usable", async () => {
    const fake = new FakeLLM([{ topics: [] }]);
    const out = await findTopics(fake, { card: card(), transcript });
    expect(out).toEqual([{ title: "Whole session", summary: "", startMs: 0, endMs: DURATION }]);
  });

  it("falls back when the call throws", async () => {
    const out = await findTopics(new FakeLLM([]), { card: card(), transcript });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Whole session", startMs: 0, endMs: DURATION });
  });

  it("propagates a MissingApiKeyError instead of falling back", async () => {
    const keyless: StructuredLLM = {
      generate: async () => {
        throw new MissingApiKeyError("ANTHROPIC_API_KEY");
      },
    };
    await expect(findTopics(keyless, { card: card(), transcript })).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("returns normalised topics from the model", async () => {
    const fake = new FakeLLM([{ topics: [t("One", 0, 10 * MIN), t("Two", 10 * MIN, 40 * MIN)] }]);
    const out = await findTopics(fake, { card: card(), transcript });
    expect(out.map((x) => x.title)).toEqual(["One", "Two"]);
    expect(fake.calls[0]).toMatchObject({ name: "topics", model: "reasoning" });
  });

  it("prompt uses the profile's topic definition", async () => {
    const fake = new FakeLLM([{ topics: [] }]);
    await findTopics(fake, { card: card("parliament"), transcript });
    expect(fake.calls[0]!.system).toContain(PROFILES.parliament.topicDefinition);
  });
});
