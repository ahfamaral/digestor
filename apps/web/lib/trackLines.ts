// Client-safe helpers for the subtitle editor's line list: times, delete, add. The checks themselves are core's.
import { applyTrackLines, formatTimestamp, MIN_LINE_MS, type TrackCue, type TrackLineInput, type TrackLineProblem } from "@digestor/core";
import { t } from "./i18n";

/** One line in the editor: `from` is the stored line it came from (null when added here), `key` is stable for React. */
export interface EditLine {
  key: string;
  startMs: number;
  endMs: number;
  text: string;
  from: number | null;
}

/** A new line gets at most this much time. */
const NEW_LINE_MS = 2000;

let nextKey = 0;
const newKey = () => `n${nextKey++}`;

export function editLinesFrom(cues: TrackCue[]): EditLine[] {
  return cues.map((c, i) => ({ key: `s${i}`, startMs: c.startMs, endMs: c.endMs, text: c.text, from: i }));
}

export function toLineInputs(lines: EditLine[]): TrackLineInput[] {
  return lines.map(({ startMs, endMs, text, from }) => ({ startMs, endMs, text, from }));
}

/** The stored lines the editor's list would save (the preview and the burn read these). */
export function previewCues(stored: TrackCue[], lines: EditLine[]): TrackCue[] {
  return applyTrackLines(stored, toLineInputs(lines));
}

/** Whether the list differs from the stored lines (text, times, count or order). */
export function linesChanged(stored: TrackCue[], lines: EditLine[]): boolean {
  return lines.length !== stored.length
    || lines.some((l, i) => l.from !== i || l.text !== stored[i]!.text || l.startMs !== stored[i]!.startMs || l.endMs !== stored[i]!.endMs);
}

/**
 * Adds an empty line at `ms` (clip time): in a gap it runs to the next line (at most 2 s, inside the clip); inside a
 * line it takes that line's rest, and the line ends at `ms`. Null when the new line (or what is left of the line it
 * cuts) would be shorter than `MIN_LINE_MS`.
 */
export function insertLineAt(lines: EditLine[], ms: number, lengthMs: number): { lines: EditLine[]; index: number } | null {
  const at = Math.round(ms);
  const inside = lines.findIndex((l) => at > l.startMs && at < l.endMs);
  if (inside >= 0) {
    const cut = lines[inside]!;
    if (at - cut.startMs < MIN_LINE_MS || cut.endMs - at < MIN_LINE_MS) return null;
    const added: EditLine = { key: newKey(), startMs: at, endMs: cut.endMs, text: "", from: null };
    const out = [...lines.slice(0, inside), { ...cut, endMs: at }, added, ...lines.slice(inside + 1)];
    return { lines: out, index: inside + 1 };
  }
  const index = lines.findIndex((l) => l.startMs >= at);
  const next = index >= 0 ? lines[index]!.startMs : lengthMs;
  const end = Math.min(next, at + NEW_LINE_MS, lengthMs);
  if (at < 0 || end - at < MIN_LINE_MS) return null;
  const added: EditLine = { key: newKey(), startMs: at, endMs: end, text: "", from: null };
  const pos = index >= 0 ? index : lines.length;
  return { lines: [...lines.slice(0, pos), added, ...lines.slice(pos)], index: pos };
}

/** "Add a line after line i": in the gap after it when there is room, else in the second half of that line. */
export function insertLineAfter(lines: EditLine[], i: number, lengthMs: number): { lines: EditLine[]; index: number } | null {
  const line = lines[i];
  if (!line) return null;
  const next = lines[i + 1]?.startMs ?? lengthMs;
  if (next - line.endMs >= MIN_LINE_MS) return insertLineAt(lines, line.endMs, lengthMs);
  return insertLineAt(lines, Math.round((line.startMs + line.endMs) / 2), lengthMs);
}

/** A time field's value for a clip time. */
export const timeField = (ms: number) => formatTimestamp(Math.max(0, ms), { tenths: true });

/** The message for a line problem (`checkTrackLines`); `n` counts from 1. */
export function lineProblemText(p: { i: number; problem: TrackLineProblem }, lengthMs: number): string {
  switch (p.problem) {
    case "empty":
      return t("prepare.problemEmpty");
    case "short":
      return t("prepare.problemShort", { n: p.i + 1 });
    case "outside":
      return t("prepare.problemOutside", { n: p.i + 1, end: timeField(lengthMs) });
    case "overlap":
      return t("prepare.problemOverlap", { n: p.i + 1, prev: p.i });
  }
}
