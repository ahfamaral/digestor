import type { CSSProperties } from "react";
import { SUBTITLE_GEOMETRY, SUBTITLE_STYLES, type SubtitlePosition, type SubtitleStyle } from "@digestor/core";

export interface SubtitleLook {
  style: SubtitleStyle;
  position: SubtitlePosition;
}

/**
 * The CSS twin of the worker's `buildAss`: the same geometry from `SUBTITLE_GEOMETRY`, scaled to the shown frame's
 * height. Close, not exact: the made video (Watch on Export) is the real check.
 * ASS draws the outline outside the glyph; `-webkit-text-stroke` is centred on the edge, so it is doubled and the fill
 * is painted over its inner half (`paint-order`). The white box is one rectangle here, one per line in libass.
 */
export function previewCss(look: SubtitleLook, frameHeightPx: number): CSSProperties {
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
    fontSize: g.fontPct * frameHeightPx,
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
