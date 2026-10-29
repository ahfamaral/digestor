import { endsSentence, formatTimestamp, type Word } from "@digestor/core";

export type Cue = { startMs: number; endMs: number; lines: string[] };

const MAX_CHARS = 42;
const MAX_LINES = 2;
const MAX_CUE_MS = 3500;
const GAP_MS = 300;
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

function wrap(units: Unit[]): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const u of units) {
    const joined = cur === "" ? u.text : cur + (u.spaceBefore ? " " : "") + u.text;
    if (cur !== "" && [...joined].length > MAX_CHARS) {
      lines.push(cur);
      cur = u.text;
    } else {
      cur = joined;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

function layout(words: Word[]): string[] {
  const units: Unit[] = [];
  words.forEach((w, i) => units.push(...toUnits(w.text, i === 0, words[i - 1]?.text)));
  return wrap(units);
}

export function buildCues(words: Word[], range: { startMs: number; endMs: number }): Cue[] {
  const inRange = words
    .filter((w) => w.endMs > range.startMs && w.startMs < range.endMs)
    .map((w) => ({ ...w, startMs: Math.max(w.startMs, range.startMs), endMs: Math.min(w.endMs, range.endMs) }));

  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    cues.push({
      startMs: cur[0]!.startMs - range.startMs,
      endMs: cur.at(-1)!.endMs - range.startMs,
      lines: layout(cur),
    });
    cur = [];
  };

  for (const word of inRange) {
    const prev = cur.at(-1);
    if (prev) {
      const tooLong = word.endMs - cur[0]!.startMs > MAX_CUE_MS;
      const gap = word.startMs - prev.endMs >= GAP_MS;
      if (tooLong || gap || layout([...cur, word]).length > MAX_LINES) flush();
    }
    cur.push(word);
    if (endsSentence(word.text)) flush();
  }
  flush();
  return cues;
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

export function buildSrt(cues: Cue[]): string {
  const t = (ms: number) => `${formatTimestamp(ms)},${pad(Math.floor(ms) % 1000, 3)}`;
  return cues.map((c, i) => `${i + 1}\n${t(c.startMs)} --> ${t(c.endMs)}\n${c.lines.join("\n")}\n`).join("\n");
}

function assTime(ms: number): string {
  const cs = Math.floor(ms / 10);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

const escapeAssText = (s: string) => s.replace(/\{/g, "\\{").replace(/\}/g, "\\}");

export function buildAss(cues: Cue[], video: { width: number; height: number }): string {
  const fontSize = Math.round(video.height * 0.055);
  const marginV = Math.round(video.height * 0.06);
  const dialogue = cues.map(
    (c) => `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs)},Default,,0,0,0,,${c.lines.map(escapeAssText).join("\\N")}`,
  );
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Default,Noto Sans,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...dialogue,
    "",
  ].join("\n");
}
