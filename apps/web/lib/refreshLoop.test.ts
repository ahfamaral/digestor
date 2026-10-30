import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRefreshLoop } from "./refreshLoop";

describe("startRefreshLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes every interval until stopped", () => {
    const refresh = vi.fn();
    const stop = startRefreshLoop(refresh, 5000);
    vi.advanceTimersByTime(4999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(20_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
