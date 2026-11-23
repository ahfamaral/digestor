import { describe, expect, it } from "vitest";
import { attachWords, buildSrt, buildVtt, cueWordsMatch, layout, trackToCues } from "./subtitleText.ts";
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
  it("layout keeps a 50-char word whole", () => {
    const w = "x".repeat(50);
    expect(layout([{ text: w, start: 0, end: 1, confidence: 1, speaker: null } as never])).toEqual([w]);
  });
  it("9:16 splits a long word that follows a normal word on the same cue", () => {
    const lines = trackToCues([cue("Der " + "y".repeat(30))], "9:16").flatMap((c) => c.lines);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(24);
    expect(lines.join("").replace(/ /g, "")).toBe("Der" + "y".repeat(30));
  });
});

describe("trackToCues with word times", () => {
  /** Words of `text`, each 300 ms long with 50 ms between them, from `startMs`; `pauses` adds extra gap before word i. */
  function spoken(text: string, startMs = 0, pauses: Record<number, number> = {}): TrackCue {
    let at = startMs;
    const words = text.split(" ").map((w, i) => {
      at += pauses[i] ?? 0;
      const word = { startMs: at, endMs: at + 300, chars: [...w].length };
      at += 350;
      return word;
    });
    return { startMs: words[0]!.startMs, endMs: words.at(-1)!.endMs, original: text, text, missing: false, words };
  }
  const SENTENCE = "the minister said the budget for schools will grow next year while hospitals wait for their share";

  it("splits a same-language line at the next screen's first word start", () => {
    const c = spoken(SENTENCE);
    const out = trackToCues([c], "9:16");
    expect(out.length).toBeGreaterThan(1);
    const firstCount = out[0]!.lines.join(" ").split(" ").length;
    expect(out[1]!.startMs).toBe(c.words![firstCount]!.startMs);
    expect(out[0]!.endMs).toBe(out[1]!.startMs);
    expect(out.at(-1)!.endMs).toBe(c.endMs);
  });

  it("never leaves the last spoken word alone on a short screen, and lights every word (real: \"…homes before | the\")", () => {
    const c = spoken("We will approve twelve thousand homes before the");
    const out = trackToCues([c], "9:16", { highlight: true });
    expect(out).toHaveLength(2);
    expect(out.at(-1)!.lines.join(" ").split(" ").length).toBeGreaterThan(1);
    for (const o of out) {
      expect(o.karaoke![0]).toBe(o.startMs);
      expect(o.karaoke!.every((ms) => ms >= o.startMs && ms < o.endMs)).toBe(true);
    }
  });

  it("splits a translation at a pause within two words of the character target", () => {
    const c = spoken(SENTENCE, 0, { 9: 400 }); // a pause before "next"
    const translated = { ...c, text: "o ministro disse que o orçamento das escolas vai crescer no próximo ano enquanto os hospitais esperam pela sua parte" };
    const out = trackToCues([translated], "9:16");
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((o) => o.startMs)).toContain(c.words![9]!.startMs);
  });

  it("keeps the character rule for lines without word times", () => {
    const c = spoken(SENTENCE);
    const plain = { ...c, words: undefined };
    const out = trackToCues([plain], "9:16");
    const sizes = out.map((o) => o.lines.join("").length);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(out[1]!.startMs).toBe(c.startMs + Math.round(((c.endMs - c.startMs) * sizes[0]!) / total));
  });

  it("an edited line splits on speech times but gets no highlight", () => {
    const c = spoken(SENTENCE);
    const edited = { ...c, text: SENTENCE.replace("minister", "prime minister") };
    const out = trackToCues([edited], "9:16", { highlight: true });
    expect(out.length).toBeGreaterThan(1);
    // The last screen may be held back to its 800 ms minimum; the first change of screen lands on a spoken word.
    expect(c.words!.map((w) => w.startMs)).toContain(out[1]!.startMs);
    expect(out.every((o) => o.karaoke === undefined)).toBe(true);
  });

  it("a translation gets no highlight even with it on", () => {
    const c = spoken("o ministro disse");
    expect(trackToCues([{ ...c, text: "the minister said" }], "16:9", { highlight: true })[0]!.karaoke).toBeUndefined();
  });

  it("highlight gives one start per token when the line is the spoken words", () => {
    const c = spoken(SENTENCE);
    const out = trackToCues([c], "9:16", { highlight: true });
    const all = out.flatMap((o) => o.karaoke ?? []);
    expect(all).toEqual(c.words!.map((w) => w.startMs));
    for (const o of out) expect(o.karaoke).toHaveLength(o.lines.join(" ").split(" ").length);
  });

  it("no highlight unless asked", () => {
    expect(trackToCues([spoken("o ministro disse")])[0]!.karaoke).toBeUndefined();
  });

  it("a CJK line with words shows plain and does not throw", () => {
    const text = "这是一个很长的中文字幕".repeat(5);
    const c: TrackCue = { startMs: 0, endMs: 9000, original: text, text, missing: false, words: [{ startMs: 0, endMs: 9000, chars: [...text].length }] };
    const out = trackToCues([c], "9:16", { highlight: true });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((o) => o.karaoke === undefined)).toBe(true);
  });

  it("keeps every screen at least 800 ms when the line is long enough", () => {
    const c = spoken(SENTENCE);
    // Most of the text sits in the last words: by characters alone the last screens would be very short.
    const out = trackToCues([{ ...c, text: "a b c " + "palavra ".repeat(20) }], "9:16");
    expect(out.length).toBeGreaterThan(2);
    for (const o of out) expect(o.endMs - o.startMs).toBeGreaterThanOrEqual(800);
  });
});

describe("cueWordsMatch", () => {
  const base = { startMs: 0, endMs: 1000, missing: false, words: [{ startMs: 0, endMs: 400, chars: 3 }, { startMs: 500, endMs: 900, chars: 4 }] };
  it("matches when the text is the original word for word", () => {
    expect(cueWordsMatch({ ...base, original: "Olá mundo", text: "Olá  mundo " })).toBe(false); // 'mundo' has 5 chars
    expect(cueWordsMatch({ ...base, original: "Olá meu!", text: "Olá meu!" })).toBe(true);
  });
  it("does not match an edit or a line without words", () => {
    expect(cueWordsMatch({ ...base, original: "Olá meu!", text: "Olá teu!" })).toBe(false);
    expect(cueWordsMatch({ ...base, words: undefined, original: "Olá meu!", text: "Olá meu!" })).toBe(false);
  });
});

describe("attachWords", () => {
  const w = [{ startMs: 0, endMs: 400, chars: 3 }];
  const line = (startMs: number, endMs: number): TrackCue => ({ startMs, endMs, original: "Olá", text: "Hi", missing: false });
  it("adds words only to lines whose start and end match a built line", () => {
    const { cues, attached } = attachWords([line(0, 400), line(500, 900)], [{ startMs: 0, endMs: 400, words: w }, { startMs: 500, endMs: 950, words: w }]);
    expect(attached).toBe(1);
    expect(cues[0]).toEqual({ ...line(0, 400), words: w });
    expect(cues[1]).toEqual(line(500, 900));
  });
  it("leaves lines that already have words", () => {
    const had = { ...line(0, 400), words: [{ startMs: 1, endMs: 2, chars: 9 }] };
    const { cues, attached } = attachWords([had], [{ startMs: 0, endMs: 400, words: w }]);
    expect(attached).toBe(0);
    expect(cues[0]).toBe(had);
  });
});
