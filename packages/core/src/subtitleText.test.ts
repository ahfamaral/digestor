import { describe, expect, it } from "vitest";
import { buildSrt, buildVtt, trackToCues } from "./subtitleText.ts";
import type { TrackCue } from "./personalTypes.ts";

const cue = (text: string, startMs = 0, endMs = 6000): TrackCue => ({ startMs, endMs, original: "x", text, missing: text === "" });
const PT = "Este é um texto muito longo em português que precisa de ser dividido em várias linhas para caber no ecrã do leitor sem cortes";

describe("trackToCues", () => {
  it("splits a long line into cues of at most 2 lines x 42 chars with contiguous proportional times", () => {
    expect(PT.length).toBeGreaterThan(120);
    const out = trackToCues([cue(PT, 1000, 7000)]);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect([...l].length).toBeLessThanOrEqual(42);
    }
    expect(out[0]!.startMs).toBe(1000);
    expect(out.at(-1)!.endMs).toBe(7000);
    out.slice(1).forEach((c, i) => expect(c.startMs).toBe(out[i]!.endMs));
    expect(out.map((c) => c.lines.join(" ")).join(" ")).toBe(PT);
    // the first chunk holds 2 full-ish lines, so it gets more than an even share only if it has more characters
    const chars = out.map((c) => c.lines.join("").length);
    const dur = out.map((c) => c.endMs - c.startMs);
    expect(dur[0]! / dur[1]!).toBeCloseTo(chars[0]! / chars[1]!, 0);
  });
  it("skips empty text", () => {
    expect(trackToCues([cue(""), cue("  "), cue("Olá.")])).toHaveLength(1);
  });
  it("wraps CJK per character", () => {
    const out = trackToCues([cue("这是一个很长的中文字幕".repeat(10))]);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) for (const l of c.lines) expect([...l].length).toBeLessThanOrEqual(42);
  });
  it("short text stays one cue with the original times", () => {
    expect(trackToCues([cue("Olá.", 5, 99)])).toEqual([{ startMs: 5, endMs: 99, lines: ["Olá."] }]);
  });
});

describe("buildVtt escaping", () => {
  it("escapes &, < and -->", () => {
    const vtt = buildVtt([{ startMs: 0, endMs: 1000, lines: ["A & B <i> --> C"] }]);
    expect(vtt).toContain("A &amp; B &lt;i> --&gt; C");
  });
  it("buildSrt keeps text as is", () => {
    expect(buildSrt([{ startMs: 0, endMs: 1000, lines: ["A & B"] }])).toContain("A & B");
  });
});

describe("trackToCues per format", () => {
  const LONG = PT.slice(0, 120);
  it("9:16 wraps at 24 chars, 2 lines per cue, covering the same time", () => {
    const out = trackToCues([cue(LONG, 1000, 7000)], "9:16");
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect([...l].length).toBeLessThanOrEqual(24);
    }
    expect(out[0]!.startMs).toBe(1000);
    expect(out.at(-1)!.endMs).toBe(7000);
  });
  it("no format argument is the 16:9 output", () => {
    expect(trackToCues([cue(PT, 1000, 7000)])).toEqual(trackToCues([cue(PT, 1000, 7000)], "16:9"));
    expect(trackToCues([cue(LONG)])[0]!.lines.every((l) => l.length <= 42)).toBe(true);
    expect(trackToCues([cue(LONG)]).length).toBe(2);
  });
  it("9:16 breaks CJK text at 24 characters", () => {
    const out = trackToCues([cue("这是一个很长的中文字幕".repeat(5))], "9:16");
    for (const c of out) for (const l of c.lines) expect([...l].length).toBeLessThanOrEqual(24);
  });
  it("9:16 hard-splits a word longer than the line", () => {
    const out = trackToCues([cue("Donaudampfschifffahrtsgesellschaftskapitän".slice(0, 30))], "9:16");
    const lines = out.flatMap((c) => c.lines);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(24);
    expect(lines.join("")).toBe("Donaudampfschifffahrtsgesellschaftskapitän".slice(0, 30));
  });
});
