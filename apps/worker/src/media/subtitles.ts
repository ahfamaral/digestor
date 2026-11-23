import {
  endsSentence, layout, MAX_LINES, repairWordTimes, type CueWord, SUBTITLE_GEOMETRY, SUBTITLE_STYLES, type ClipFormat, type Cue, type SubtitlePosition, type SubtitleStyle, type Word,
} from "@digestor/core";

export { buildSrt, buildVtt, type Cue } from "@digestor/core";

const MAX_CUE_MS = 3500;
const GAP_MS = 300;

/**
 * Cues of the clip's words, each with its words' clip-relative times (stored on track lines for splitting and
 * highlighting). Word times a noisy stretch got wrong (crushed next to stretched words) are repaired first.
 */
export function buildCues(words: Word[], range: { startMs: number; endMs: number }): (Cue & { words: CueWord[] })[] {
  const inRange = repairWordTimes(
    words
      .filter((w) => w.endMs > range.startMs && w.startMs < range.endMs)
      .map((w) => ({ ...w, startMs: Math.max(w.startMs, range.startMs), endMs: Math.min(w.endMs, range.endMs) })),
  );

  const groups: Word[][] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length > 0) groups.push(cur);
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

  // A full cue can leave the last word of a sentence alone on the next one ("können."). When the speech runs on (no
  // pause, the previous cue did not end its sentence), that word takes the previous cue's last word along.
  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1]!;
    const g = groups[i]!;
    if (g.length !== 1 || prev.length < 3) continue;
    const last = prev.at(-1)!;
    if (endsSentence(last.text) || g[0]!.startMs - last.endMs >= GAP_MS) continue;
    const moved = [last, g[0]!];
    if (layout(moved).length > MAX_LINES) continue;
    prev.pop();
    groups[i] = moved;
  }

  return groups.map((ws) => ({
    startMs: ws[0]!.startMs - range.startMs,
    endMs: ws.at(-1)!.endMs - range.startMs,
    lines: layout(ws),
    words: ws.map((w) => ({ startMs: w.startMs - range.startMs, endMs: w.endMs - range.startMs, chars: [...w.text].length })),
  }));
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

function assTime(ms: number): string {
  const cs = Math.floor(ms / 10);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

const escapeAssText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");

/** Opacity 0…1 → ASS alpha byte (00 opaque … FF transparent), two hex digits. */
const assAlpha = (opacity: number) => Math.round((1 - opacity) * 255).toString(16).toUpperCase().padStart(2, "0");

/** CSS `#RRGGBB` → ASS `&HAABBGGRR` colour. */
function assColour(hex: string, alpha = "00"): string {
  const h = hex.replace("#", "").toUpperCase();
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

/**
 * A cue's text with a `\k` (centiseconds) before each word: the time from the cue's start to its first word, then each
 * word until the next one starts (the last until the cue ends). Positions are rounded once, so the durations add up
 * to the cue's length exactly.
 */
export function karaokeText(c: Cue): string {
  const end = Math.max(1, Math.round((c.endMs - c.startMs) / 10));
  let prev = 0;
  const at = c.karaoke!.map((ms) => (prev = Math.min(end, Math.max(prev, Math.round((ms - c.startMs) / 10)))));
  let i = 0;
  const lines = c.lines.map((line) =>
    line.split(/\s+/).filter(Boolean).map((word) => {
      const next = i + 1 < at.length ? at[i + 1]! : end;
      const tag = `{\\k${next - at[i]!}}${escapeAssText(word)}`;
      i++;
      return tag;
    }).join(" "),
  );
  return (at[0]! > 0 ? `{\\k${at[0]}}` : "") + lines.join("\\N");
}

export function buildAss(
  cues: Cue[],
  video: { width: number; height: number },
  look: { style: SubtitleStyle; position: SubtitlePosition; format: ClipFormat },
): string {
  const g = SUBTITLE_GEOMETRY;
  const st = SUBTITLE_STYLES[look.style];
  const fontSize = Math.round(video.height * g.fontPct[look.format]);
  const marginV = Math.round(video.height * g.marginPct[look.position]);
  const alignment = look.position === "top" ? 8 : 2;
  const outline = Math.round((g.outlinePx1080 * video.height) / 1080);
  const shadow = st.box ? 0 : Math.round((g.shadowPx1080 * video.height) / 1080);
  // BorderStyle 3 draws the box in OutlineColour (libass), so the box colour goes there and in BackColour.
  const boxColour = assColour("#000000", assAlpha(g.boxOpacity));
  const outlineColour = st.box ? boxColour : assColour("#000000");
  const backColour = st.box ? boxColour : assColour("#000000");
  const primary = assColour(st.color);
  // Word highlighting: karaoke shows words not reached yet in SecondaryColour (dimmed), then PrimaryColour.
  const secondary = assColour(st.color, assAlpha(g.upcomingOpacity));
  const dialogue = cues.flatMap((c) => {
    const at = `${assTime(c.startMs)},${assTime(Math.max(c.endMs, c.startMs + 10))},Default,,0,0,0,`;
    const plain = c.lines.map(escapeAssText).join("\\N");
    if (!c.karaoke) return [`Dialogue: 0,${at},${plain}`];
    // libass boxes each karaoke word on its own (seams where they overlap): with a box, layer 0 draws one box per line
    // with invisible text, and layer 1 the highlighted words with an invisible box.
    if (!st.box) return [`Dialogue: 0,${at},${karaokeText(c)}`];
    return [`Dialogue: 0,${at},{\\1a&HFF&\\2a&HFF&}${plain}`, `Dialogue: 1,${at},{\\3a&HFF&\\4a&HFF&}${karaokeText(c)}`];
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Default,Noto Sans,${fontSize},${primary},${secondary},${outlineColour},${backColour},${st.bold ? -1 : 0},0,0,0,100,100,0,0,${st.box ? 3 : 1},${outline},${shadow},${alignment},20,20,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...dialogue,
    "",
  ].join("\n");
}
