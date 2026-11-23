import type { ClipFormat } from "./personalTypes.ts";
import { SUBTITLE_GEOMETRY } from "./subtitleStyle.ts";
import { formatTimestamp } from "./time.ts";
import type { CueWord, TrackCue } from "./personalTypes.ts";
import type { Word } from "./schemas.ts";

/**
 * One on-screen subtitle. `karaoke` (word highlighting only): the clip-relative start of each whitespace token of
 * `lines.join(" ")`, in order.
 */
export type Cue = { startMs: number; endMs: number; lines: string[]; karaoke?: number[] };

/** A gap between two words at least this long counts as a pause: a good place to change screens. */
export const SPLIT_PAUSE_MS = 150;
/** Each screen of a split line stays at least this long when the line is long enough. */
export const MIN_PIECE_MS = 800;
/** How many words either side of the character target a pause may move the split. */
const SPLIT_WINDOW = 2;

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

/** A unit longer than the line (a long compound word) is cut into line-sized chunks: the renderer cannot break inside a word. */
function hardSplit(units: Unit[], maxChars: number): Unit[] {
  return units.flatMap((u) => {
    const chars = [...u.text];
    if (chars.length <= maxChars) return [u];
    const out: Unit[] = [];
    for (let i = 0; i < chars.length; i += maxChars) out.push({ text: chars.slice(i, i + maxChars).join(""), spaceBefore: i === 0 && u.spaceBefore });
    return out;
  });
}

function wrap(units: Unit[], maxChars = MAX_CHARS, splitLongWords = false): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const u of splitLongWords ? hardSplit(units, maxChars) : units) {
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
  return wrap(units, maxChars, true);
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const norm = (s: string) => tokens(s).join(" ");

/**
 * The line still says exactly what was spoken, word for word: its text equals its original and the original's
 * tokens match the stored words one to one. Only then can a word be highlighted as it is said. (CJK originals have no
 * spaces between words, so they never match: shown plain.)
 */
export function cueWordsMatch(cue: TrackCue): boolean {
  const words = cue.words;
  if (!words?.length || norm(cue.text) !== norm(cue.original)) return false;
  const toks = tokens(cue.original);
  return toks.length === words.length && toks.every((t, i) => [...t].length === words[i]!.chars);
}

/**
 * Where a split lands when the shown text isn't the spoken words (a translation, an edit): the word start closest to
 * the same fraction of the original's characters, moved to a pause (≥ `SPLIT_PAUSE_MS`) within `SPLIT_WINDOW` words.
 */
function speechBoundary(words: CueWord[], fraction: number): number {
  const total = words.reduce((n, w) => n + w.chars, 0) + words.length - 1;
  let before = 0;
  let best = 1;
  let bestDist = Infinity;
  for (let k = 1; k < words.length; k++) {
    before += words[k - 1]!.chars + 1;
    const d = Math.abs(before / total - fraction);
    if (d < bestDist) [best, bestDist] = [k, d];
  }
  const gap = (k: number) => words[k]!.startMs - words[k - 1]!.endMs;
  let pick = best;
  for (let off = 0; off <= SPLIT_WINDOW; off++) {
    const found = [best - off, best + off].find((k) => k >= 1 && k < words.length && gap(k) >= SPLIT_PAUSE_MS);
    if (found !== undefined) {
      pick = found;
      break;
    }
  }
  return words[pick]!.startMs;
}

/** Keeps split times increasing and, when the line is long enough, every screen at least `MIN_PIECE_MS`. */
function clampBoundaries(times: number[], startMs: number, endMs: number): number[] {
  const pieces = times.length + 1;
  const min = endMs - startMs >= MIN_PIECE_MS * pieces ? MIN_PIECE_MS : 0;
  const out: number[] = [];
  let prev = startMs;
  times.forEach((t, i) => {
    const hi = endMs - min * (pieces - 1 - i);
    const v = Math.min(Math.max(t, prev + min), hi);
    out.push(v);
    prev = v;
  });
  return out;
}

/**
 * Splits a line that is the spoken words into `screens` screens (each at most `MAX_LINES` lines of `maxChars`) so the
 * shortest screen, timed by its words, lasts as long as possible. Null when no such split exists (a word too long
 * for a line).
 */
function balanceScreens(text: string, words: CueWord[], screens: number, maxChars: number, endMs: number): string[][] | null {
  const toks = tokens(text);
  const n = toks.length;
  const fit = (a: number, b: number): string[] | null => {
    const lines = wrapText(toks.slice(a, b).join(" "), maxChars);
    return lines.length <= MAX_LINES && tokens(lines.join(" ")).length === b - a ? lines : null;
  };
  const at = (i: number) => (i === n ? endMs : words[i]!.startMs);
  // best[k][i]: the longest shortest-screen for the first i words in k screens, and where its last screen starts.
  const best: { score: number; from: number }[][] = Array.from({ length: screens + 1 }, () => Array.from({ length: n + 1 }, () => ({ score: -Infinity, from: -1 })));
  best[0]![0] = { score: Infinity, from: -1 };
  for (let k = 1; k <= screens; k++) {
    for (let i = 1; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        const prev = best[k - 1]![j]!.score;
        if (prev === -Infinity || !fit(j, i)) continue;
        const score = Math.min(prev, at(i) - at(j));
        if (score > best[k]![i]!.score) best[k]![i] = { score, from: j };
      }
    }
  }
  if (best[screens]![n]!.score === -Infinity) return null;
  const out: string[][] = [];
  for (let k = screens, i = n; k > 0; k--) {
    const j = best[k]![i]!.from;
    out.unshift(fit(j, i)!);
    i = j;
  }
  return out;
}

/**
 * Track cues to renderable cues: each text is wrapped to the format's line width (`SUBTITLE_GEOMETRY.maxChars`) and 2
 * lines per cue. Text that needs more lines is split into consecutive cues. Where the next screen starts:
 * - the line is the spoken words (`cueWordsMatch`): at its first word's start;
 * - other text with word times (a translation, an edit): at a spoken word near the same point, preferring a pause;
 * - no word times (tracks built before them): the cue's time divided by characters.
 * `highlight` adds each token's start (`karaoke`) to lines that are the spoken words. Empty text is skipped.
 */
export function trackToCues(cues: TrackCue[], format: ClipFormat = "16:9", opts: { highlight?: boolean } = {}): Cue[] {
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
    // One word gives nothing to split on: the character rule.
    const words = c.words && c.words.length > 1 ? c.words : null;

    // A line that is the spoken words is cut between words so every screen lasts as long as it can (no lonely last
    // word on a screen of its own); each screen then starts exactly when its first word is said.
    const balanced = words && chunks.length > 1 && cueWordsMatch(c) ? balanceScreens(c.text, words, chunks.length, maxChars, c.endMs) : null;
    if (balanced) chunks.splice(0, chunks.length, ...balanced);
    // Tokens per screen; they line up with the words only when no word was cut to fit the line.
    const counts = chunks.map((ch) => tokens(ch.join(" ")).length);
    const exact = words !== null && cueWordsMatch(c) && counts.reduce((a, b) => a + b, 0) === words.length;
    const firstToken: number[] = [];
    counts.reduce((at, n) => (firstToken.push(at), at + n), 0);

    let starts: number[];
    if (words && chunks.length > 1 && exact && balanced) {
      starts = firstToken.map((k, i) => (i === 0 ? c.startMs : words[k]!.startMs));
    } else if (words && chunks.length > 1) {
      let done = 0;
      const raw = chunks.slice(1).map((_, i) => {
        done += sizes[i]!;
        return exact ? words[firstToken[i + 1]!]!.startMs : speechBoundary(words, done / total);
      });
      starts = [c.startMs, ...clampBoundaries(raw, c.startMs, c.endMs)];
    } else {
      let done = 0;
      starts = sizes.map((n) => {
        const s = c.startMs + Math.round((span * done) / total);
        done += n;
        return s;
      });
    }
    chunks.forEach((ch, i) => {
      const cue: Cue = { startMs: starts[i]!, endMs: i === chunks.length - 1 ? c.endMs : starts[i + 1]!, lines: ch };
      if (opts.highlight && exact) cue.karaoke = words!.slice(firstToken[i]!, firstToken[i]! + counts[i]!).map((w) => w.startMs);
      out.push(cue);
    });
  }
  return out;
}

/**
 * Gives stored lines that lack word times the words of the matching freshly built line (same start and end): used once
 * for tracks made before word times were stored. Text, approval and everything else stay as they are.
 */
export function attachWords(
  stored: TrackCue[],
  built: { startMs: number; endMs: number; words: CueWord[] }[],
): { cues: TrackCue[]; attached: number } {
  const byRange = new Map(built.map((b) => [`${b.startMs}-${b.endMs}`, b.words]));
  let attached = 0;
  const cues = stored.map((c) => {
    if (c.words?.length) return c;
    const words = byRange.get(`${c.startMs}-${c.endMs}`);
    if (!words?.length) return c;
    attached++;
    return { ...c, words };
  });
  return { cues, attached };
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

