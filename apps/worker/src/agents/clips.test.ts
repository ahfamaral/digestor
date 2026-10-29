import { describe, expect, it } from "vitest";
import { EVENT_TYPES, findBoundaries, type Candidate, type ContextCard, type Fact, type Word } from "@digestor/core";
import {
  buildHotTakePrompt,
  buildLongClipPrompt,
  findClips,
  longClipLimits,
  normalizeCandidates,
} from "./clips.js";
import { FakeLLM } from "../llm/structured.js";

const none: Fact = { value: null, source: null, evidence: null };

const card: ContextCard = {
  language: { value: "English", source: "video", evidence: "x" },
  eventType: { value: "interview", confidence: 0.9, evidence: "x" },
  title: none,
  summary: "An interview.",
  setting: none,
  dateOrYear: { value: "March 2026", source: "metadata", evidence: "March 2026" },
  participants: [],
  sufficient: true,
  openQuestions: [],
};

// One 2 s sentence every 3 s: 400 sentences => 1200 s.
function mkWords(sentences: number): Word[] {
  const out: Word[] = [];
  for (let s = 0; s < sentences; s++) {
    const base = s * 3000;
    const texts = ["Sentence", `number`, `${s}.`];
    texts.forEach((t, i) =>
      out.push({ text: t, startMs: base + i * 600, endMs: base + i * 600 + 500, speaker: "A", confidence: 0.99 }),
    );
  }
  return out;
}
const words = mkWords(400);
const durationMs = 1_200_000;
const boundaries = findBoundaries(words, durationMs);

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  title: "T",
  reason: "r",
  label: "key_point",
  score: 80,
  start: "00:02:00",
  end: "00:05:00",
  evidence: [],
  ...over,
});
const opts = { durationMs, boundaries, minMs: 60_000, maxMs: 1_200_000 };

describe("normalizeCandidates", () => {
  it("drops malformed and reversed candidates", () => {
    const out = normalizeCandidates(
      [cand({ start: "1:2:3x" }), cand({ start: "00:05:00", end: "00:04:00" }), cand()],
      opts,
    );
    expect(out).toHaveLength(1);
  });

  it("snaps to boundaries", () => {
    const [c] = normalizeCandidates([cand({ start: "00:02:01", end: "00:05:01" })], opts);
    const starts = boundaries.map((b) => Math.max(b.afterWordEndMs, b.beforeWordStartMs - 150));
    expect(starts).toContain(c!.startMs);
    expect(c!.endMs).toBeGreaterThan(c!.startMs);
  });

  it("dedupes overlapping candidates keeping higher score", () => {
    const out = normalizeCandidates(
      [cand({ score: 60 }), cand({ score: 90, start: "00:02:03", end: "00:05:03" })],
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(90);
  });

  it("drops candidates outside the length limits and sorts by score", () => {
    const out = normalizeCandidates(
      [cand({ start: "00:00:00", end: "00:00:20" }), cand({ score: 50 }), cand({ score: 70, start: "00:10:00", end: "00:13:00" })],
      opts,
    );
    expect(out.map((c) => c.score)).toEqual([70, 50]);
  });
});

describe("longClipLimits", () => {
  it("relaxes the long-clip minimum for a 5-minute video", () => {
    expect(longClipLimits(300_000).minMs).toBe(75_000);
    expect(longClipLimits(300_000).maxMs).toBe(1_200_000);
    expect(longClipLimits(1_200_000)).toEqual({ minMs: 60_000, maxMs: 1_200_000 });
  });
});

describe("prompts", () => {
  it("uses the detected event type rubric and context date", () => {
    const p = buildLongClipPrompt({ card, words, durationMs });
    expect(p.system).toContain(EVENT_TYPES.interview.rubric);
    expect(p.system).toContain("March 2026");
    expect(p.system).toContain("English");
    expect(p.user).toContain("[00:00:00]");
  });

  it("limits the hot-take transcript to the parent range", () => {
    const parent = { title: "P", reason: "r", label: "light" as const, score: 80, startMs: 60_000, endMs: 120_000, children: [] };
    const p = buildHotTakePrompt({ card, parent, words });
    expect(p.user).toContain("[00:01:00]");
    expect(p.user).not.toContain("[00:03:00]");
  });
});

describe("findClips", () => {
  const transcript = { language: "en", languageConfidence: 0.99, durationMs, words };

  it("runs pass 2 once per surviving parent, children inside parent", async () => {
    const llm = new FakeLLM([
      {
        clips: [
          cand({ start: "00:02:00", end: "00:05:00", score: 90 }),
          cand({ start: "00:10:00", end: "00:13:00", score: 70 }),
        ],
      },
      { hotTakes: [cand({ start: "00:02:30", end: "00:03:00" }), cand({ start: "00:04:30", end: "00:06:30" })] },
      { hotTakes: [] },
    ]);
    const out = await findClips(llm, { card, transcript });
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls.map((c) => c.name)).toEqual(["long_clips", "hot_takes", "hot_takes"]);
    expect(llm.calls.every((c) => c.model === "reasoning")).toBe(true);
    expect(out).toHaveLength(2);
    for (const p of out) {
      for (const c of p.children) {
        expect(c.startMs).toBeGreaterThanOrEqual(p.startMs);
        expect(c.endMs).toBeLessThanOrEqual(p.endMs);
      }
    }
    const first = out.find((p) => p.score === 90)!;
    expect(first.children.length).toBeGreaterThanOrEqual(1);
  });

  it("returns [] without calling the LLM for an empty transcript", async () => {
    const llm = new FakeLLM([]);
    expect(await findClips(llm, { card, transcript: { ...transcript, words: [] } })).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});
