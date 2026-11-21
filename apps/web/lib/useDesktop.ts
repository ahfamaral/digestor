"use client";

import { useSyncExternalStore } from "react";

/** From this width the Ask drawer is a side panel beside the Briefing (Tailwind `lg`); below it a modal sheet. */
const DESKTOP = "(min-width: 1024px)";
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
