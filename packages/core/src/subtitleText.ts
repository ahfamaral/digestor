import type { ClipFormat } from "./personalTypes.ts";
import { SUBTITLE_GEOMETRY } from "./subtitleStyle.ts";
import { formatTimestamp } from "./time.ts";
import type { TrackCue } from "./personalTypes.ts";
import type { Word } from "./schemas.ts";

export type Cue = { startMs: number; endMs: number; lines: string[] };

export const MAX_CHARS = 42;
export const MAX_LINES = 2;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/u;

type Unit = { text: string; spaceBefore: boolean };

/** Split a word into wrap units: CJK text breaks per character, everything else stays whole. */
function toUnits(word: string, first: boolean, prevText: string | undefined): Unit[] {
  const chars = [...word];
  const cjkWord = chars.some((c) => CJK.test(c));
  if (!cjkWord) return [{ text: word, spaceBefore: !first }];
  const prevLast = prevText === undefined ? undefined : [...prevText].at(-1);
  const spaceBefore = !first && prevLast !== undefined && !CJK.test(prevLast) && !CJK.test(chars[0]!);
  return chars.map((c, i) => ({ text: c, spaceBefore: i === 0 && spaceBefore }));
}

function wrap(units: Unit[], maxChars = MAX_CHARS): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const u of units) {
    const joined = cur === "" ? u.text : cur + (u.spaceBefore ? " " : "") + u.text;
    if (cur !== "" && [...joined].length > maxChars) {
      lines.push(cur);
      cur = u.text;
    } else {
      cur = joined;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

export function layout(words: Word[]): string[] {
  const units: Unit[] = [];
  words.forEach((w, i) => units.push(...toUnits(w.text, i === 0, words[i - 1]?.text)));
  return wrap(units);
}


/** Wraps a plain string (CJK breaks per character, other scripts per word). */
export function wrapText(text: string, maxChars = MAX_CHARS): string[] {
  const units: Unit[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  words.forEach((w, i) => units.push(...toUnits(w, i === 0, words[i - 1])));
  return wrap(units, maxChars);
}

/**
 * Track cues to renderable cues: each text is wrapped to the format's line width (`SUBTITLE_GEOMETRY.maxChars`) and 2 lines per cue. Text that
 * needs more lines is split into consecutive cues, dividing the cue's time by characters. Empty text is skipped.
 */
export function trackToCues(cues: TrackCue[], format: ClipFormat = "16:9"): Cue[] {
  const out: Cue[] = [];
  const maxChars = SUBTITLE_GEOMETRY.maxChars[format];
  for (const c of cues) {
    const lines = wrapText(c.text, maxChars);
    if (lines.length === 0) continue;
    const chunks: string[][] = [];
    for (let i = 0; i < lines.length; i += MAX_LINES) chunks.push(lines.slice(i, i + MAX_LINES));
    const sizes = chunks.map((ch) => ch.reduce((n, l) => n + [...l].length, 0));
    const total = sizes.reduce((a, b) => a + b, 0);
    const span = Math.max(0, c.endMs - c.startMs);
    let done = 0;
    chunks.forEach((ch, i) => {
      const startMs = c.startMs + Math.round((span * done) / total);
      done += sizes[i]!;
      const endMs = i === chunks.length - 1 ? c.endMs : c.startMs + Math.round((span * done) / total);
      out.push({ startMs, endMs, lines: ch });
    });
  }
  return out;
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

export function buildSrt(cues: Cue[]): string {
  const t = (ms: number) => `${formatTimestamp(ms)},${pad(Math.floor(ms) % 1000, 3)}`;
  return cues.map((c, i) => `${i + 1}\n${t(c.startMs)} --> ${t(c.endMs)}\n${c.lines.join("\n")}\n`).join("\n");
}

const escapeVtt = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/-->/g, "--&gt;");

export function buildVtt(cues: Cue[]): string {
  const t = (ms: number) => `${formatTimestamp(ms)}.${pad(Math.floor(ms) % 1000, 3)}`;
  return `WEBVTT\n\n${cues.map((c) => `${t(c.startMs)} --> ${t(c.endMs)}\n${c.lines.map(escapeVtt).join("\n")}\n`).join("\n")}`;
}

