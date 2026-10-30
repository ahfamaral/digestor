import { describe, expect, it } from "vitest";
import { bannerKey, readBannerDismissed, writeBannerDismissed } from "./bannerDismiss";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}
const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("banner dismiss", () => {
  it("remembers a dismissal per session", () => {
    const s = memoryStorage();
    expect(readBannerDismissed(s, "s1")).toBe(false);
    expect(writeBannerDismissed(s, "s1")).toBe(true);
    expect(s.data.get(bannerKey("s1"))).toBe("1");
    expect(readBannerDismissed(s, "s1")).toBe(true);
    expect(readBannerDismissed(s, "s2")).toBe(false);
  });

  it("treats missing or failing storage as not dismissed and never throws", () => {
    expect(readBannerDismissed(null, "s1")).toBe(false);
    expect(writeBannerDismissed(null, "s1")).toBe(false);
    expect(readBannerDismissed(throwing, "s1")).toBe(false);
    expect(writeBannerDismissed(throwing, "s1")).toBe(false);
  });
});
