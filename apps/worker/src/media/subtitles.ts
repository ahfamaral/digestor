import {
  endsSentence, layout, MAX_LINES, SUBTITLE_GEOMETRY, SUBTITLE_STYLES, type ClipFormat, type Cue, type SubtitlePosition, type SubtitleStyle, type Word,
} from "@digestor/core";

export { buildSrt, buildVtt, type Cue } from "@digestor/core";

const MAX_CUE_MS = 3500;
const GAP_MS = 300;

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
  const dialogue = cues.map(
    (c) => `Dialogue: 0,${assTime(c.startMs)},${assTime(Math.max(c.endMs, c.startMs + 10))},Default,,0,0,0,,${c.lines.map(escapeAssText).join("\\N")}`,
  );
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
    `Style: Default,Noto Sans,${fontSize},${primary},${primary},${outlineColour},${backColour},${st.bold ? -1 : 0},0,0,0,100,100,0,0,${st.box ? 3 : 1},${outline},${shadow},${alignment},20,20,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...dialogue,
    "",
  ].join("\n");
}
