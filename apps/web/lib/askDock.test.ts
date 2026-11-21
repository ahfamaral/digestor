import { describe, expect, it } from "vitest";
import { askDockKey, initialAskOpen, readAskDock, showDraftBanner, writeAskDock } from "./askDock";

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("ask dock", () => {
  it("docks by default on desktop only when the session has a goal and the user hasn't closed it", () => {
    expect(initialAskOpen({ desktop: true, hasGoal: true, remembered: null })).toBe(true);
    expect(initialAskOpen({ desktop: true, hasGoal: true, remembered: "open" })).toBe(true);
    expect(initialAskOpen({ desktop: true, hasGoal: false, remembered: "open" })).toBe(false);
    expect(initialAskOpen({ desktop: true, hasGoal: true, remembered: "closed" })).toBe(false);
    expect(initialAskOpen({ desktop: false, hasGoal: true, remembered: null })).toBe(false);
  });

  it("the phone banner shows only with a goal whose Ask started, until closed once", () => {
    const base = { desktop: false, hasGoal: true, askStarted: true, remembered: null, open: false } as const;
    expect(showDraftBanner(base)).toBe(true);
    expect(showDraftBanner({ ...base, desktop: true })).toBe(false);
    expect(showDraftBanner({ ...base, hasGoal: false })).toBe(false);
    expect(showDraftBanner({ ...base, askStarted: false })).toBe(false);
    expect(showDraftBanner({ ...base, remembered: "closed" })).toBe(false);
    expect(showDraftBanner({ ...base, open: true })).toBe(false);
  });

  it("remembers the state per session", () => {
    const data = new Map<string, string>();
    const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(readAskDock(s, "a")).toBeNull();
    expect(writeAskDock(s, "a", "closed")).toBe(true);
    expect(readAskDock(s, "a")).toBe("closed");
    expect(readAskDock(s, "b")).toBeNull();
    expect(askDockKey("a")).toBe("digestor:ask:a");
    data.set(askDockKey("c"), "junk");
    expect(readAskDock(s, "c")).toBeNull();
  });

  it("storage that throws reads as null and writes return false", () => {
    expect(readAskDock(throwing, "a")).toBeNull();
    expect(writeAskDock(throwing, "a", "open")).toBe(false);
    expect(readAskDock(null, "a")).toBeNull();
    expect(writeAskDock(null, "a", "open")).toBe(false);
  });
});
