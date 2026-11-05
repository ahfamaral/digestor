import type { Word } from "@digestor/core";
import { describe, expect, it } from "vitest";
import { buildAss, buildCues, buildSrt, buildVtt } from "./subtitles.js";

const w = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs, speaker: "A", confidence: 0.9 });

// one word every 400 ms from 8 s to 22 s, 0.1 s gaps
const words: Word[] = Array.from({ length: 35 }, (_, i) => w(`word${i}`, 8000 + i * 400, 8000 + i * 400 + 300));

describe("buildCues", () => {
  it("cues are relative to the clip start and exclude outside words", () => {
    const cues = buildCues(words, { startMs: 10_000, endMs: 20_000 });
    expect(cues[0]!.startMs).toBeGreaterThanOrEqual(0);
    expect(cues.at(-1)!.endMs).toBeLessThanOrEqual(10_000);
    const text = cues.flatMap((c) => c.lines).join(" ");
    expect(text).not.toContain("word0 ");
    expect(text).toContain("word10");
  });

  it("a free cut that starts and ends mid-sentence keeps only words inside the range", () => {
    const sentence = [w("alpha", 0, 500), w("bravo", 600, 1100), w("charlie", 1200, 1700), w("delta", 1800, 2300), w("echo.", 2400, 2900)];
    const cues = buildCues(sentence, { startMs: 1150, endMs: 1850 });
    const text = cues.flatMap((c) => c.lines).join(" ");
    expect(text).toBe("charlie delta");
    expect(cues[0]!.startMs).toBe(50);
    expect(cues.at(-1)!.endMs).toBeLessThanOrEqual(700);
  });

  it("clips words straddling the range", () => {
    const cues = buildCues([w("a", 900, 1200), w("b", 1900, 2300)], { startMs: 1000, endMs: 2000 });
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([[0, 200], [900, 1000]]);
  });

  it("no cue line exceeds 42 chars and no cue exceeds 2 lines", () => {
    const long = Array.from({ length: 60 }, (_, i) => w("palavra" + "x".repeat(i % 5), i * 200, i * 200 + 150));
    const cues = buildCues(long, { startMs: 0, endMs: 20_000 });
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(42);
    }
  });

  it("wraps CJK text without spaces", () => {
    const text = "你".repeat(60);
    const cues = buildCues([w(text, 0, 2000)], { startMs: 0, endMs: 3000 });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.lines).toHaveLength(2);
    for (const l of cues[0]!.lines) expect(l.length).toBeLessThanOrEqual(42);
    expect(cues[0]!.lines.join("")).toBe(text);
  });

  it("breaks at sentence end, gap >= 300 ms and 3500 ms", () => {
    const sentence = buildCues([w("Oi.", 0, 200), w("Sim", 250, 400)], { startMs: 0, endMs: 1000 });
    expect(sentence).toHaveLength(2);
    const gap = buildCues([w("um", 0, 200), w("dois", 500, 700)], { startMs: 0, endMs: 1000 });
    expect(gap).toHaveLength(2);
    const noGap = buildCues([w("um", 0, 200), w("dois", 499, 700)], { startMs: 0, endMs: 1000 });
    expect(noGap).toHaveLength(1);
    const slow = Array.from({ length: 12 }, (_, i) => w("w", i * 400, i * 400 + 350));
    const cues = buildCues(slow, { startMs: 0, endMs: 5000 });
    for (const c of cues) expect(c.endMs - c.startMs).toBeLessThanOrEqual(3500);
    expect(cues.length).toBeGreaterThan(1);
  });

  it("puts a single over-long word on its own line", () => {
    const cues = buildCues([w("a".repeat(50), 0, 500), w("b", 520, 600)], { startMs: 0, endMs: 1000 });
    expect(cues[0]!.lines).toEqual(["a".repeat(50), "b"]);
  });

  it("returns [] for no words in range", () => {
    expect(buildCues(words, { startMs: 100_000, endMs: 110_000 })).toEqual([]);
  });
});

describe("buildSrt / buildAss", () => {
  const cues = [
    { startMs: 0, endMs: 1500, lines: ["Hello", "world"] },
    { startMs: 3_723_456, endMs: 3_725_000, lines: ["Later"] },
  ];

  it("srt is numbered with comma millis", () => {
    const srt = buildSrt(cues);
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:01,500\nHello\nworld\n\n2\n01:02:03,456 --> 01:02:05,000\nLater\n/);
  });

  it("ass has script info, style and dialogue lines", () => {
    const ass = buildAss([{ startMs: 0, endMs: 1500, lines: ["a {b}", "c"] }, cues[1]!], { width: 640, height: 360 });
    expect(ass).toContain("PlayResX: 640");
    expect(ass).toContain("PlayResY: 360");
    expect(ass).toContain("WrapStyle: 2");
    expect(ass).toContain("Style: Default,Noto Sans,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,22,1");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,a \\{b\\}\\Nc");
    expect(ass).toContain("Dialogue: 0,1:02:03.45,1:02:05.00,Default,,0,0,0,,Later");
  });

  it("escapes literal backslashes and never emits zero-duration cues", () => {
    const ass = buildAss([{ startMs: 1000, endMs: 1000, lines: ["a\\Nb"] }], { width: 640, height: 360 });
    expect(ass).toContain("Default,,0,0,0,,a\\\\Nb");
    expect(ass).toContain("0:00:01.00,0:00:01.01,Default");
  });
});

describe("buildVtt", () => {
  it("formats times with milliseconds", () => {
    const vtt = buildVtt([
      { startMs: 0, endMs: 1500, lines: ["Hello"] },
      { startMs: 3_723_004, endMs: 3_725_000, lines: ["Two", "lines"] },
    ]);
    expect(vtt).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n\n01:02:03.004 --> 01:02:05.000\nTwo\nlines\n");
  });
});
