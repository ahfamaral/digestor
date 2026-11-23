import type { Word } from "@digestor/core";
import { describe, expect, it } from "vitest";
import { buildAss, buildCues, buildSrt, buildVtt, karaokeText } from "./subtitles.js";

const w = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs, speaker: "A", confidence: 0.9 });

// one word every 400 ms from 8 s to 22 s, 0.1 s gaps
const words: Word[] = Array.from({ length: 35 }, (_, i) => w(`word${i}`, 8000 + i * 400, 8000 + i * 400 + 300));

describe("buildCues", () => {
  it("repairs crushed word times before grouping (real: a crowd chant, 7 words in 0.47 s)", () => {
    const base = 91_894;
    const chant: [string, number, number][] = [
      ["nossa", 25574, 28027], ["luta", 28027, 29630], ["pelo", 29790, 29950], ["fim", 29950, 29998], ["da", 29998, 30030],
      ["escala", 30030, 30110], ["6", 30110, 30159], ["por", 30159, 30223], ["1!", 30223, 30255],
    ];
    const cues = buildCues(chant.map(([t, a, b]) => w(t, base + a, base + b)), { startMs: base, endMs: base + 35_000 });
    const all = cues.flatMap((c) => c.words);
    // "pelo fim da escala 6 por 1!" now takes well over a second, not 0.47 s
    expect(all.at(-1)!.endMs - all[2]!.startMs).toBeGreaterThan(1500);
    expect(all[0]!.startMs).toBe(25574);
    expect(all.at(-1)!.endMs).toBe(30255);
  });
  it("a sentence's last word is not left alone on a cue when the speech is continuous (real: \"können.\", \"abbauen.\")", () => {
    const text = "und endlich ausreichend Geld vom Bund, damit die Kommunen das auch umsetzen können.".split(" ");
    let t = 0;
    const ws = text.map((x) => {
      const word = w(x, t, t + 150);
      t += 200;
      return word;
    });
    const cues = buildCues(ws, { startMs: 0, endMs: t });
    for (const c of cues) expect(c.lines.join(" ").split(" ").length).toBeGreaterThan(1);
    expect(cues.map((c) => c.lines.join(" ")).join(" ")).toBe(text.join(" "));
    expect(cues.at(-1)!.lines.join(" ")).toBe("umsetzen können.");
  });

  it("a one-word sentence after a pause or a finished sentence stays on its own cue", () => {
    const ws = [w("Das", 0, 300), w("stimmt.", 350, 700), w("Warum?", 1500, 1900)];
    const cues = buildCues(ws, { startMs: 0, endMs: 2000 });
    expect(cues.map((c) => c.lines.join(" "))).toEqual(["Das stimmt.", "Warum?"]);
  });

  it("cues are relative to the clip start and exclude outside words", () => {
    const cues = buildCues(words, { startMs: 10_000, endMs: 20_000 });
    expect(cues[0]!.startMs).toBeGreaterThanOrEqual(0);
    expect(cues.at(-1)!.endMs).toBeLessThanOrEqual(10_000);
    const text = cues.flatMap((c) => c.lines).join(" ");
    expect(text).not.toContain("word0 ");
    expect(text).toContain("word10");
  });

  it("each cue carries its words with clip-relative times and lengths", () => {
    const cues = buildCues(words, { startMs: 10_000, endMs: 20_000 });
    for (const c of cues) {
      expect(c.words.map((w) => w.chars)).toEqual(c.lines.join(" ").split(" ").map((x) => [...x].length));
      expect(c.words[0]!.startMs).toBe(c.startMs);
      expect(c.words.at(-1)!.endMs).toBe(c.endMs);
    }
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

const look = (over: Partial<{ style: "yellow" | "white" | "white_box" | "yellow_box"; position: "bottom" | "above_banner" | "top"; format: "16:9" | "9:16" }> = {}) => ({
  style: "yellow" as const, position: "bottom" as const, format: "16:9" as const, ...over,
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
    const ass = buildAss([{ startMs: 0, endMs: 1500, lines: ["a {b}", "c"] }, cues[1]!], { width: 640, height: 360 }, look());
    expect(ass).toContain("PlayResX: 640");
    expect(ass).toContain("PlayResY: 360");
    expect(ass).toContain("WrapStyle: 0");
    expect(ass).toContain("Style: Default,Noto Sans,20,&H0000E6FF,&H7300E6FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,2,20,20,22,1");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,a \\{b\\}\\Nc");
    expect(ass).toContain("Dialogue: 0,1:02:03.45,1:02:05.00,Default,,0,0,0,,Later");
  });

  it("9:16 uses a 4% font on 1080x1920 and 16:9 stays at 5.5%", () => {
    const v = buildAss(cues, { width: 1080, height: 1920 }, look({ format: "9:16" }));
    expect(v).toContain("Noto Sans,77,");
    expect(v).toContain("WrapStyle: 0");
    expect(buildAss(cues, { width: 1920, height: 1080 }, look({ format: "16:9" }))).toContain("Noto Sans,59,");
  });

  it("yellow on dark box draws a box behind yellow text", () => {
    const ass = buildAss(cues, { width: 1920, height: 1080 }, look({ style: "yellow_box" }));
    expect(ass).toMatch(/Style: Default,Noto Sans,59,&H0000E6FF,&H7300E6FF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,3,/);
  });

  it("a cue with word times writes \\k tags that add up to the cue's length", () => {
    const cue = { startMs: 1000, endMs: 3005, lines: ["um dois", "três"], karaoke: [1203, 1777, 2500] };
    const text = karaokeText(cue);
    expect(text).toBe("{\\k20}{\\k58}um {\\k72}dois\\N{\\k51}três");
    const sum = [...text.matchAll(/\\k(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(sum).toBe(Math.round((cue.endMs - cue.startMs) / 10));
    expect(buildAss([cue], { width: 1920, height: 1080 }, look())).toContain(",,0,0,0,,{\\k20}{\\k58}um");
  });

  it("with a box style, a highlighted cue draws the box once below the highlighted words", () => {
    const cue = { startMs: 0, endMs: 1000, lines: ["um dois"], karaoke: [0, 500] };
    const ass = buildAss([cue], { width: 1920, height: 1080 }, look({ style: "yellow_box" }));
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\1a&HFF&\\2a&HFF&}um dois");
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\3a&HFF&\\4a&HFF&}{\\k50}um {\\k50}dois");
  });

  it("a cue without word times has no \\k tags", () => {
    expect(buildAss(cues, { width: 1920, height: 1080 }, look())).not.toContain("\\k");
  });

  it("yellow above the banner at 1080p", () => {
    const ass = buildAss(cues, { width: 1920, height: 1080 }, look({ position: "above_banner" }));
    expect(ass).toContain("&H0000E6FF");
    expect(ass).toContain(",-1,0,0,0,100,100,0,0,1,4,1,2,");
    expect(ass).toContain(",2,20,20,238,1");
    expect(ass).toContain("Noto Sans,59,");
  });

  it("white is bold white with an outline", () => {
    const ass = buildAss(cues, { width: 1920, height: 1080 }, look({ style: "white" }));
    expect(ass).toContain("Noto Sans,59,&H00FFFFFF,&H73FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,1,2,20,20,65,1");
  });

  it("top uses alignment 8 and the top margin", () => {
    const ass = buildAss(cues, { width: 1920, height: 1080 }, look({ position: "top" }));
    expect(ass).toContain(",8,20,20,54,1");
  });

  it("white_box draws a 75% black box with border style 3", () => {
    const ass = buildAss(cues, { width: 1920, height: 1080 }, look({ style: "white_box" }));
    expect(ass).toContain("&H00FFFFFF,&H73FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,3,");
  });

  it("escapes literal backslashes and never emits zero-duration cues", () => {
    const ass = buildAss([{ startMs: 1000, endMs: 1000, lines: ["a\\Nb"] }], { width: 640, height: 360 }, look());
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
