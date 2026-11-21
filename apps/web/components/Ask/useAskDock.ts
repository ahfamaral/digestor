"use client";

import { useEffect, useState } from "react";
import { browserStorage } from "@/lib/bannerDismiss";
import { initialAskOpen, readAskDock, writeAskDock, type AskDockState } from "@/lib/askDock";
import { isDesktopNow, useDesktop } from "@/lib/useDesktop";

/**
 * Whether the Ask drawer is open. It starts closed (so does the server render), then opens once after mount when
 * `initialAskOpen` says so; the journalist's own open or close is remembered per session in this browser.
 */
export function useAskDock(sessionId: string, hasGoal: boolean) {
  const desktop = useDesktop();
  const [open, setOpenState] = useState(false);
  const [remembered, setRemembered] = useState<AskDockState | null>(null);

  useEffect(() => {
    const stored = readAskDock(browserStorage(), sessionId);
    setRemembered(stored);
    if (initialAskOpen({ desktop: isDesktopNow(), hasGoal, remembered: stored })) setOpenState(true);
    // Once after mount: later width changes or edits never open the panel by themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setOpen(next: boolean) {
    setOpenState(next);
    const state: AskDockState = next ? "open" : "closed";
    setRemembered(state);
    writeAskDock(browserStorage(), sessionId, state);
  }

  return { open, setOpen, desktop, remembered };
}
