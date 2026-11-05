"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Pauses the element when its page goes away. Next keeps a page you left inside `<Activity mode="hidden">`
 * (display:none, still mounted), and React runs layout-effect cleanups when that boundary hides.
 *
 * React Strict Mode (dev) runs setup, cleanup, setup in one go on mount; that cleanup's pause would cancel an
 * `autoPlay` that was already requested, so on that first mount only, a setup right after a cleanup restarts
 * autoplay. (Showing the page again must not: it stays paused where it was.)
 */
export function usePauseWhenHidden(ref: RefObject<HTMLMediaElement | null>): void {
  const mounting = useRef(true);
  const cleaned = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && mounting.current && cleaned.current && el.autoplay) void el.play().catch(() => {});
    queueMicrotask(() => {
      mounting.current = false;
    });
    return () => {
      el?.pause();
      cleaned.current = true;
    };
  }, [ref]);
}
