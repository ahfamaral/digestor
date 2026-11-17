"use client";

import { useCallback, useRef, type CSSProperties, type RefObject } from "react";
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
  poster,
  preload = "none",
  mediaRef,
  onTime,
  controls = true,
  onPlayingChange,
}: {
  kind: "video" | "audio";
  src: string | undefined;
  label: string;
  autoPlay?: boolean;
  className?: string;
  style?: CSSProperties;
  tracks?: MediaTrack[];
  poster?: string;
  preload?: "none" | "metadata";
  /** The element, for a caller that seeks it. */
  mediaRef?: RefObject<HTMLMediaElement | null>;
  /** Called with `currentTime` in seconds while it plays or seeks. */
  onTime?: (seconds: number) => void;
  /** false: the caller draws its own controls (e.g. times inside a clip, which the browser's controls can't show). */
  controls?: boolean;
  /** Called when it starts or stops playing. */
  onPlayingChange?: (playing: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const setRef = useCallback(
    (el: (HTMLVideoElement & HTMLAudioElement) | null) => {
      ref.current = el;
      if (mediaRef) mediaRef.current = el;
    },
    [mediaRef],
  );
  usePauseWhenHidden(ref);
  const children = tracks?.map((tr) => <track key={tr.srcLang} kind="subtitles" src={tr.src} srcLang={tr.srcLang} label={tr.label} />);
  const common = {
    controls,
    autoPlay,
    preload,
    src,
    "aria-label": label,
    className,
    style,
    onTimeUpdate: onTime ? (e: React.SyntheticEvent<HTMLMediaElement>) => onTime(e.currentTarget.currentTime) : undefined,
    onPlay: onPlayingChange ? () => onPlayingChange(true) : undefined,
    onPause: onPlayingChange ? () => onPlayingChange(false) : undefined,
  };
  return kind === "video" ? (
    <video ref={setRef} poster={poster} {...common}>
      {children}
    </video>
  ) : (
    <audio ref={setRef} {...common}>
      {children}
    </audio>
  );
}
