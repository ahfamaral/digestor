import { describe, expect, it } from "vitest";
import { applyTrackLines, checkTrackLines, repairWordTimes, trackLinesVersion } from "./trackLines.ts";
import type { TrackCue } from "./personalTypes.ts";
import type { Word } from "./schemas.ts";

const stored: TrackCue[] = [
  { startMs: 0, endMs: 2000, original: "Olá a todos.", text: "Hola a todos.", missing: false, words: [
    { startMs: 0, endMs: 500, chars: 3 }, { startMs: 600, endMs: 800, chars: 1 }, { startMs: 900, endMs: 2000, chars: 6 },
  ] },
  { startMs: 2500, endMs: 4000, original: "Obrigado.", text: "Gracias.", missing: false, words: [{ startMs: 2500, endMs: 4000, chars: 9 }] },
];

describe("checkTrackLines", () => {
  const ok = [{ startMs: 0, endMs: 1000, text: "a" }, { startMs: 1000, endMs: 2000, text: "b" }];
  it("accepts ordered lines inside the clip, touching allowed", () => {
    expect(checkTrackLines(ok, 2000)).toEqual([]);
  });
  it("names lines that are too short, outside, out of order or overlapping", () => {
    expect(checkTrackLines([{ startMs: 0, endMs: 100 }], 5000)).toEqual([{ i: 0, problem: "short" }]);
    expect(checkTrackLines([{ startMs: 500, endMs: 300 }], 5000)).toEqual([{ i: 0, problem: "short" }]);
    expect(checkTrackLines([{ startMs: 0, endMs: 6000 }], 5000)).toEqual([{ i: 0, problem: "outside" }]);
    expect(checkTrackLines([{ startMs: 0, endMs: 1500 }, { startMs: 1000, endMs: 2000 }], 5000))
      .toEqual([{ i: 1, problem: "overlap" }]);
  });
  it("refuses an empty list", () => {
    expect(checkTrackLines([], 5000)).toEqual([{ i: -1, problem: "empty" }]);
  });
});

describe("applyTrackLines", () => {
  it("keeps original and words while a line's times are unchanged", () => {
    const out = applyTrackLines(stored, [{ startMs: 0, endMs: 2000, text: "Hola.", from: 0 }]);
    expect(out[0]).toEqual({ ...stored[0], text: "Hola.", missing: false });
  });
  it("drops word times when a line's times change, keeping the original", () => {
    const out = applyTrackLines(stored, [{ startMs: 0, endMs: 2000, text: "Hola a todos.", from: 0 }, { startMs: 2700, endMs: 4000, text: "Gracias.", from: 1 }]);
    expect(out[1]!.words).toBeUndefined();
    expect(out[1]!.original).toBe("Obrigado.");
    expect(out[0]!.words).toHaveLength(3);
  });
  it("adds a line with no original, marked added, missing while empty", () => {
    const out = applyTrackLines(stored, [{ startMs: 2000, endMs: 2400, text: " ", from: null }]);
    expect(out[0]).toEqual({ startMs: 2000, endMs: 2400, original: "", text: " ", missing: true, added: true });
  });
  it("ignores a `from` that points at no stored line", () => {
    expect(applyTrackLines(stored, [{ startMs: 0, endMs: 500, text: "x", from: 9 }])[0]!.added).toBe(true);
  });
});

describe("trackLinesVersion", () => {
  it("changes with text or times and not with words", () => {
    const v = trackLinesVersion(stored);
    expect(trackLinesVersion(stored.map((c) => ({ ...c, words: undefined })))).toBe(v);
    expect(trackLinesVersion([{ ...stored[0]!, text: "x" }, stored[1]!])).not.toBe(v);
    expect(trackLinesVersion([{ ...stored[0]!, endMs: 2100 }, stored[1]!])).not.toBe(v);
  });
});

const w = (text: string, startMs: number, endMs: number, speaker = "A"): Word => ({ text, startMs, endMs, confidence: 0.9, speaker });

describe("repairWordTimes", () => {
  // AssemblyAI on a crowd chant (clip ms): two stretched words, then seven crushed into under half a second.
  const chant = [
    w("e", 25157, 25237), w("a", 25237, 25414), w("nossa", 25574, 28027), w("luta", 28027, 29630), w("pelo", 29790, 29950),
    w("fim", 29950, 29998), w("da", 29998, 30030), w("escala", 30030, 30110), w("6", 30110, 30159), w("por", 30159, 30223),
    w("1!", 30223, 30255), w("Provoca,", 30287, 30399), w("irmão!", 30415, 30511), w("Como", 30543, 30607),
    w("encaminham", 30607, 30736), w("governo.", 30704, 31693), w("Deputada", 31807, 32942),
  ];
  it("spreads a crushed run over the stretched words before it, by characters", () => {
    const out = repairWordTimes(chant);
    expect(out.map((x) => x.text)).toEqual(chant.map((x) => x.text));
    const nossa = out[2]!;
    const enc = out[14]!;
    expect(nossa.startMs).toBe(25574);
    expect(enc.endMs).toBe(30736);
    // every word in the span is now at least 25 ms a character, contiguous and in order
    for (let i = 2; i <= 14; i++) {
      expect(out[i]!.endMs - out[i]!.startMs).toBeGreaterThanOrEqual(25 * [...out[i]!.text].length);
      if (i > 2) expect(out[i]!.startMs).toBe(out[i - 1]!.endMs);
    }
    // "pelo fim da escala 6 por 1!" now takes about 2 s, not 0.47 s
    expect(out[10]!.endMs - out[4]!.startMs).toBeGreaterThan(1500);
    // words outside the span are untouched
    expect(out[0]).toEqual(chant[0]);
    expect(out[15]).toEqual(chant[15]);
  });
  it("leaves a crushed run with no stretched neighbour alone", () => {
    const fast = [w("isto", 0, 400), w("é", 400, 420), w("um", 420, 440), w("de", 440, 460), w("ok.", 460, 900)];
    expect(repairWordTimes(fast)).toEqual(fast);
  });
  it("leaves normal speech alone", () => {
    const normal = [w("Viva", 17286, 17879), w("a", 17944, 18120), w("classe", 18408, 18777), w("trabalhadora", 18777, 21134)];
    expect(repairWordTimes(normal)).toEqual(normal);
  });
  it("borrows from a stretched word after the run too", () => {
    const after = [w("um", 0, 30), w("dois", 30, 60), w("três", 60, 90), w("quatro", 90, 3000), w("cinco.", 3100, 3500)];
    const out = repairWordTimes(after);
    expect(out[0]!.startMs).toBe(0);
    expect(out[3]!.endMs).toBe(3000);
    expect(out[1]!.endMs - out[1]!.startMs).toBeGreaterThan(400);
    expect(out[4]).toEqual(after[4]);
  });
});
