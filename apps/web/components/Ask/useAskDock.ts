"use client";

import { useEffect, useState } from "react";
import { browserStorage } from "@/lib/bannerDismiss";
import { initialAskOpen, readAskDock, writeAskDock, type AskDockState } from "@/lib/askDock";
import { isDesktopNow, useDesktop } from "@/lib/useDesktop";

/**
 * Whether the Ask drawer is open. It starts closed (so does the server render), then opens once after mount when
 * `initialAskOpen` says so (`ready` flips in that same effect); the journalist's own open or close is remembered per session in this browser.
 */
export function useAskDock(sessionId: string, hasGoal: boolean) {
  const desktop = useDesktop();
  const [open, setOpenState] = useState(false);
  const [remembered, setRemembered] = useState<AskDockState | null>(null);
  /** False on the server and during hydration; true once the width and storage have been read. */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readAskDock(browserStorage(), sessionId);
    // Storage and width are only readable after hydration (a lazy initial state would not match the server HTML).
    /* eslint-disable react-hooks/set-state-in-effect -- reading browser storage after mount is deliberate */
    setRemembered(stored);
    setReady(true);
    if (initialAskOpen({ desktop: isDesktopNow(), hasGoal, remembered: stored })) setOpenState(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Once after mount: later width changes or edits never open the panel by themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setOpen(next: boolean) {
    setOpenState(next);
    const state: AskDockState = next ? "open" : "closed";
    setRemembered(state);
    writeAskDock(browserStorage(), sessionId, state);
  }

  return { open, setOpen, desktop, remembered, ready };
}
