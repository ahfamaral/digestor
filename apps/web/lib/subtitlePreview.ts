import type { CSSProperties } from "react";
import { SUBTITLE_GEOMETRY, SUBTITLE_STYLES, type ClipFormat, type SubtitlePosition, type SubtitleStyle } from "@digestor/core";

export interface SubtitleLook {
  style: SubtitleStyle;
  position: SubtitlePosition;
}

/** The positions offered: a waveform (audio-only file) has no name banner to sit above. */
export function subtitlePositions(hasVideo: boolean): SubtitlePosition[] {
  return hasVideo ? ["bottom", "above_banner", "top"] : ["bottom", "top"];
}

/** The look the style dialog starts from: a position it doesn't offer starts at the bottom. */
export function startingLook(look: SubtitleLook, hasVideo: boolean): SubtitleLook {
  return subtitlePositions(hasVideo).includes(look.position) ? look : { ...look, position: "bottom" };
}

/**
 * The CSS twin of the worker's `buildAss`: the same geometry from `SUBTITLE_GEOMETRY`, scaled to the shown frame's
 * height. Close, not exact: the made video (Watch on Export) is the real check.
 * ASS draws the outline outside the glyph; `-webkit-text-stroke` is centred on the edge, so it is doubled and the fill
 * is painted over its inner half (`paint-order`). The white box is one rectangle here, one per line in libass.
 */
export function previewCss(look: SubtitleLook & { format: ClipFormat }, frameHeightPx: number): CSSProperties {
  const g = SUBTITLE_GEOMETRY;
  const st = SUBTITLE_STYLES[look.style];
  const outline = Math.round((g.outlinePx1080 * frameHeightPx) / 1080);
  const shadow = Math.round((g.shadowPx1080 * frameHeightPx) / 1080);
  const margin = `${+(g.marginPct[look.position] * 100).toFixed(2)}%`;
  const css: CSSProperties = {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    width: "max-content",
    maxWidth: "96%",
    textAlign: "center",
    whiteSpace: "pre",
    lineHeight: 1.25,
    color: st.color,
    fontWeight: st.bold ? 700 : 400,
    fontSize: g.fontPct[look.format] * frameHeightPx,
    ...(look.position === "top" ? { top: margin } : { bottom: margin }),
  };
  if (st.box) {
    css.backgroundColor = `rgba(0,0,0,${g.boxOpacity})`;
    css.padding = `${outline}px`;
  } else {
    css.WebkitTextStroke = `${outline * 2}px #000`;
    css.paintOrder = "stroke fill";
    css.textShadow = `0px ${shadow}px 0px #000`;
  }
  return css;
}

/** Index of the cue playing at `clipMs` (clip-relative, like the cues), or -1 in a gap or outside the cues. */
export function cueAt(cues: { startMs: number; endMs: number }[], clipMs: number): number {
  return cues.findIndex((c) => clipMs >= c.startMs && clipMs < c.endMs);
}

/** Where to seek the preview copy (session time, in seconds) to show a cue: cues are relative to the clip start. */
export function seekFor(cue: { startMs: number }, clip: { startMs: number }): number {
  return (clip.startMs + cue.startMs) / 1000;
}

/** The review shows the "Original" column only when the track is in another language than the video's. */
export function reviewColumns(trackLanguage: string, originalLanguage: string | null | undefined): 1 | 2 {
  if (!originalLanguage) return 2;
  const primary = (code: string) => code.toLowerCase().split(/[-_]/)[0];
  return primary(trackLanguage) === primary(originalLanguage) ? 1 : 2;
}
