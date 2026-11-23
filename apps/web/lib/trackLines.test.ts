import { describe, expect, it } from "vitest";
import type { TrackCue } from "@digestor/core";
import { editLinesFrom, insertLineAfter, insertLineAt, lineProblemText, linesChanged, previewCues } from "./trackLines";

const cues: TrackCue[] = [
  { startMs: 0, endMs: 2000, original: "Um.", text: "One.", missing: false, words: [{ startMs: 0, endMs: 2000, chars: 3 }] },
  { startMs: 3000, endMs: 3300, original: "Dois.", text: "Two.", missing: false },
  { startMs: 3300, endMs: 5000, original: "Três.", text: "Three.", missing: false },
];
const span = (r: { lines: { startMs: number; endMs: number }[] } | null) => r?.lines.map((l) => [l.startMs, l.endMs]);

describe("editor line list", () => {
  it("starts unchanged and notices text, time, deletion", () => {
    const lines = editLinesFrom(cues);
    expect(linesChanged(cues, lines)).toBe(false);
    expect(linesChanged(cues, lines.map((l, i) => (i === 0 ? { ...l, endMs: 1900 } : l)))).toBe(true);
    expect(linesChanged(cues, lines.slice(1))).toBe(true);
  });
  it("adds a line in a gap, up to the next line", () => {
    const r = insertLineAt(editLinesFrom(cues), 2200, 10_000);
    expect(r?.index).toBe(1);
    expect(span(r)).toEqual([[0, 2000], [2200, 3000], [3000, 3300], [3300, 5000]]);
    expect(r!.lines[1]).toMatchObject({ text: "", from: null });
  });
  it("adds a line at most 2 s long, inside the clip", () => {
    expect(span(insertLineAt(editLinesFrom(cues), 5000, 10_000))?.at(-1)).toEqual([5000, 7000]);
    expect(span(insertLineAt(editLinesFrom(cues), 9000, 9500))?.at(-1)).toEqual([9000, 9500]);
    expect(insertLineAt(editLinesFrom(cues), 9400, 9500)).toBeNull();
  });
  it("inside a line, cuts it at the playhead", () => {
    const r = insertLineAt(editLinesFrom(cues), 1000, 10_000);
    expect(span(r)!.slice(0, 2)).toEqual([[0, 1000], [1000, 2000]]);
    expect(r!.lines[0]!.from).toBe(0);
  });
  it("refuses a cut that leaves under 0.2 s", () => {
    expect(insertLineAt(editLinesFrom(cues), 3100, 10_000)).toBeNull();
  });
  it("after a line: uses the gap when there is room, else halves the line", () => {
    expect(span(insertLineAfter(editLinesFrom(cues), 0, 10_000))!.slice(0, 2)).toEqual([[0, 2000], [2000, 3000]]);
    expect(span(insertLineAfter(editLinesFrom(cues), 2, 10_000))!.at(-1)).toEqual([5000, 7000]);
    // line 2 (3300–5000) touches nothing after it here, but line 1 (3000–3300) has no room and is too short to halve
    expect(insertLineAfter(editLinesFrom(cues), 1, 10_000)).toBeNull();
    const tight = editLinesFrom([cues[0]!, { ...cues[1]!, startMs: 2000, endMs: 4000 }]);
    expect(span(insertLineAfter(tight, 0, 10_000))).toEqual([[0, 1000], [1000, 2000], [2000, 4000]]);
  });
  it("previews moved lines without word times and added lines as added", () => {
    const r = insertLineAt(editLinesFrom(cues), 1000, 10_000)!;
    const out = previewCues(cues, r.lines);
    expect(out[0]!.words).toBeUndefined();
    expect(out[1]).toMatchObject({ added: true, original: "", missing: true });
  });
  it("names problems for people", () => {
    expect(lineProblemText({ i: 3, problem: "overlap" }, 5000)).toBe("Line 4 starts before line 3 ends.");
    expect(lineProblemText({ i: 0, problem: "outside" }, 35_000)).toBe("Line 1 runs outside the clip (00:00:00.0 to 00:00:35.0).");
  });
});
