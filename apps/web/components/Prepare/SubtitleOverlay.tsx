"use client";

import { Fragment } from "react";
import { Noto_Sans } from "next/font/google";
import { SUBTITLE_STYLES, type ClipFormat, type Cue } from "@digestor/core";
import { previewCss, spokenTokens, upcomingColor, type SubtitleLook } from "@/lib/subtitlePreview";

// The worker draws subtitles in Noto Sans; the previews load it too.
const noto = Noto_Sans({ subsets: ["latin", "latin-ext"], weight: ["400", "700"], display: "swap" });

/**
 * One on-screen subtitle drawn over a frame as the burn draws it (`previewCss`). A cue with word times (`karaoke`)
 * shows the words spoken by `nowMs` in the style's colour and the rest dimmed. Hidden from screen readers: the
 * lines are listed as text elsewhere.
 */
export function SubtitleOverlay({
  cue, look, format, frameHeight, nowMs, lang,
}: {
  cue: Pick<Cue, "lines" | "karaoke">;
  look: Pick<SubtitleLook, "style" | "position">;
  format: ClipFormat;
  frameHeight: number;
  /** Clip-relative time (ms), for word highlighting. */
  nowMs: number;
  lang: string;
}) {
  if (frameHeight <= 0) return null;
  const spoken = cue.karaoke ? spokenTokens(cue as Cue, nowMs) : 0;
  let i = 0;
  return (
    <div aria-hidden lang={lang} dir="auto" className={noto.className} style={previewCss({ ...look, format }, frameHeight)} data-testid="subtitle-preview">
      {cue.karaoke
        ? cue.lines.map((line, li) => (
            <Fragment key={li}>
              {li > 0 && "\n"}
              {line.split(/\s+/).filter(Boolean).map((word, wi) => {
                const lit = i++ < spoken;
                return (
                  <Fragment key={wi}>
                    {wi > 0 && " "}
                    <span style={{ color: lit ? SUBTITLE_STYLES[look.style].color : upcomingColor(look.style) }}>{word}</span>
                  </Fragment>
                );
              })}
            </Fragment>
          ))
        : cue.lines.join("\n")}
    </div>
  );
}
