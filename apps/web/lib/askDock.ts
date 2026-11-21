import type { KeyValueStore } from "./bannerDismiss";

export type AskDockState = "open" | "closed";

export const askDockKey = (sessionId: string) => `digestor:ask:${sessionId}`;

/** What the journalist last chose for this session in this browser; null when nothing is stored or storage fails. */
export function readAskDock(storage: KeyValueStore | null, sessionId: string): AskDockState | null {
  try {
    const v = storage?.getItem(askDockKey(sessionId));
    return v === "open" || v === "closed" ? v : null;
  } catch {
    return null;
  }
}

/** Remembers the choice; false when it couldn't be stored (the choice then holds for this view only). */
export function writeAskDock(storage: KeyValueStore | null, sessionId: string, state: AskDockState): boolean {
  if (!storage) return false;
  try {
    storage.setItem(askDockKey(sessionId), state);
    return true;
  } catch {
    return false;
  }
}

/** Ask opens by itself only beside the page on a desktop, for a session with a goal, unless it was closed before. */
export function initialAskOpen(a: { desktop: boolean; hasGoal: boolean; remembered: AskDockState | null }): boolean {
  return a.desktop && a.hasGoal && a.remembered !== "closed";
}

/** The phone's "Ask has a draft for you" banner: a goal whose Ask started, not closed before, drawer not open, and only once the client knows the width and storage (`ready`). */
export function showDraftBanner(a: { desktop: boolean; hasGoal: boolean; askStarted: boolean; remembered: AskDockState | null; open: boolean; ready: boolean }): boolean {
  return a.ready && !a.desktop && a.hasGoal && a.askStarted && a.remembered !== "closed" && !a.open;
}
