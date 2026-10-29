import { describe, expect, it, vi } from "vitest";
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

  it("keeps the 25 best of 26 long clips instead of rejecting the response", async () => {
    // 30 min transcript; 26 non-overlapping ~63 s clips, scores 90 down to 65.
    const longWords = mkWords(600);
    const longTranscript = { language: "en", languageConfidence: 0.99, durationMs: 1_800_000, words: longWords };
    const ts = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    const clips = Array.from({ length: 26 }, (_, i) => cand({ start: ts(i * 66 + 1), end: ts(i * 66 + 64), score: 90 - i }));
    const llm = new FakeLLM([{ clips }, ...Array.from({ length: 25 }, () => ({ hotTakes: [] }))]);
    const out = await findClips(llm, { card, transcript: longTranscript });
    expect(out).toHaveLength(25);
    expect(out.map((c) => c.score)).not.toContain(65);
    expect(llm.calls.filter((c) => c.name === "hot_takes")).toHaveLength(25);
  });

  it("drops a candidate with a malformed timestamp and keeps the others (h:mm:ss accepted)", async () => {
    const llm = new FakeLLM([
      {
        clips: [
          cand({ start: "0:02:00", end: "0:05:00", score: 90 }),
          cand({ start: "00:06:00", end: "00:0x:00", score: 80 }),
          cand({ start: "00:10:00", end: "00:13:00", score: 70 }),
        ],
      },
      { hotTakes: [] },
      { hotTakes: [] },
    ]);
    const out = await findClips(llm, { card, transcript });
    expect(out.map((c) => c.score)).toEqual([90, 70]);
  });

  it("keeps at most 4 hot takes per long clip, the best ones", async () => {
    const takes = [
      ["00:02:00", "00:02:20"],
      ["00:02:30", "00:02:50"],
      ["00:03:00", "00:03:20"],
      ["00:03:30", "00:03:50"],
      ["00:04:00", "00:04:20"],
    ].map(([start, end], i) => cand({ start, end, score: 50 + i }));
    const llm = new FakeLLM([{ clips: [cand({ start: "00:02:00", end: "00:05:00", score: 90 })] }, { hotTakes: takes }]);
    const [parent] = await findClips(llm, { card, transcript });
    expect(parent!.children).toHaveLength(4);
    expect(parent!.children.map((c) => c.score).sort((a, b) => a - b)).toEqual([51, 52, 53, 54]);
    const starts = parent!.children.map((c) => c.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("one failing hot-take call leaves that parent without children; the others still get theirs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const llm = new FakeLLM([
        {
          clips: [
            cand({ start: "00:02:00", end: "00:05:00", score: 90 }),
            cand({ start: "00:10:00", end: "00:13:00", score: 70 }),
          ],
        },
        { nope: "not a hot-take response" }, // parent 1: the call fails
        { hotTakes: [cand({ start: "00:10:30", end: "00:11:00" })] },
      ]);
      const out = await findClips(llm, { card, transcript });
      expect(out.map((c) => [c.score, c.children.length])).toEqual([
        [90, 0],
        [70, 1],
      ]);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("returns [] without calling the LLM for an empty transcript", async () => {
    const llm = new FakeLLM([]);
    expect(await findClips(llm, { card, transcript: { ...transcript, words: [] } })).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});
