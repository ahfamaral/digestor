/** The few Storage methods the context banner needs (a fake in tests, `localStorage` in the browser). */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

export const bannerKey = (sessionId: string) => `digestor:banner:${sessionId}`;

/** `localStorage`, or null where it is missing or blocked (merely touching it can throw a SecurityError). */
export function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether the context banner was dismissed for this session in this browser; false when storage fails. */
export function readBannerDismissed(storage: KeyValueStore | null, sessionId: string): boolean {
  try {
    return storage?.getItem(bannerKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

/** Remembers the dismissal; returns false when it couldn't be stored (the banner then hides for this view only). */
export function writeBannerDismissed(storage: KeyValueStore | null, sessionId: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(bannerKey(sessionId), "1");
    return true;
  } catch {
    return false;
  }
}
