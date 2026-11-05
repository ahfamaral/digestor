"use client";

import { useRef, type CSSProperties } from "react";
import { usePauseWhenHidden } from "@/lib/usePauseWhenHidden";

export type MediaTrack = { src: string; srcLang: string; label: string };

/** A video or audio player that pauses when its page is hidden (see `usePauseWhenHidden`). */
export function MediaPlayer({
  kind,
  src,
  label,
  autoPlay,
  className,
  style,
  tracks,
}: {
  kind: "video" | "audio";
  src: string | undefined;
  label: string;
  autoPlay?: boolean;
  className?: string;
  style?: CSSProperties;
  tracks?: MediaTrack[];
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  usePauseWhenHidden(ref);
  const children = tracks?.map((tr) => <track key={tr.srcLang} kind="subtitles" src={tr.src} srcLang={tr.srcLang} label={tr.label} />);
  const common = { controls: true, autoPlay, preload: "none" as const, src, "aria-label": label, className, style };
  return kind === "video" ? (
    <video ref={ref} {...common}>
      {children}
    </video>
  ) : (
    <audio ref={ref} {...common}>
      {children}
    </audio>
  );
}
