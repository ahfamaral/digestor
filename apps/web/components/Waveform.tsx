"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { WAVEFORM } from "@digestor/core";
import { sampleColumns, waveColumns, waveLines } from "@/lib/waveform";

type Tap = { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> };

// One audio context for the page. A media element can be connected to it only once, and from then on its sound goes
// through the context, so each element keeps its tap.
let context: AudioContext | null = null;
const taps = new WeakMap<HTMLMediaElement, Tap>();

function tapOf(el: HTMLMediaElement): Tap | null {
  const known = taps.get(el);
  if (known) return known;
  try {
    context ??= new AudioContext();
    const source = context.createMediaElementSource(el);
    const analyser = context.createAnalyser();
    // About 46 ms of sound at 44.1 kHz across the frame: what one frame of the render (25 fps) shows.
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyser.connect(context.destination);
    const tap = { analyser, buf: new Float32Array(analyser.fftSize) };
    taps.set(el, tap);
    return tap;
  } catch (err) {
    console.error("waveform: no audio analyser", err);
    return null;
  }
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * The picture an audio-only clip gets when it is made: a white waveform on dark, filling its frame. While `playing`, it
 * follows the sound of `mediaRef` every frame; stopped, it is a flat line; `still` draws a fixed sample (nothing plays).
 * With reduced motion it stays flat and the sound is left alone. Decorative: the player is the accessible control.
 */
export function Waveform({
  mediaRef, playing = false, still = false, className,
}: {
  mediaRef?: RefObject<HTMLMediaElement | null>;
  playing?: boolean;
  still?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect;
      setSize({ w: Math.round(box.width), h: Math.round(box.height) });
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    const draw = (levels: number[]) => {
      g.fillStyle = WAVEFORM.background;
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = WAVEFORM.line;
      for (const [x, top, h] of waveLines(levels, size.w, size.h)) g.fillRect(x * dpr, top * dpr, Math.max(1, dpr), h * dpr);
    };
    const flat = () => draw(new Array<number>(size.w).fill(0));

    if (still) {
      draw(sampleColumns(size.w));
      return;
    }
    const el = mediaRef?.current;
    if (!playing || !el || reducedMotion()) {
      flat();
      return;
    }
    const tap = tapOf(el);
    if (!tap) {
      flat();
      return;
    }
    void context?.resume().catch(() => {});
    let frame = 0;
    const tick = () => {
      tap.analyser.getFloatTimeDomainData(tap.buf);
      draw(waveColumns(tap.buf, size.w));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      flat();
    };
  }, [size, playing, still, mediaRef]);

  return <canvas ref={canvasRef} aria-hidden className={className ?? "absolute inset-0 h-full w-full"} />;
}
