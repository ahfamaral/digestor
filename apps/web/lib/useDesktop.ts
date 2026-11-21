"use client";

import { useSyncExternalStore } from "react";

/** From this width the Ask drawer is a side panel beside the Briefing (Tailwind `lg`); below it a modal sheet. */
const DESKTOP = "(min-width: 1024px)";
/** The width now, read directly (the hook still says false during hydration). */
export const isDesktopNow = () => window.matchMedia(DESKTOP).matches;

export function useDesktop(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(DESKTOP);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
}
