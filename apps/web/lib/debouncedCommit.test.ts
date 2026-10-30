import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debouncedCommit } from "./debouncedCommit";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("debouncedCommit", () => {
  it("sends only the last value after the pause, once", () => {
    const send = vi.fn();
    const c = debouncedCommit<number>(send, 400, 0);
    c.push(0.05);
    vi.advanceTimersByTime(300);
    c.push(0.1);
    c.push(0.15);
    vi.advanceTimersByTime(399);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(0.15);
  });

  it("flush sends a pending value now; a later flush (blur after release) sends nothing", () => {
    const send = vi.fn();
    const c = debouncedCommit<number>(send, 400, 0);
    c.push(0.5);
    c.flush();
    c.flush();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(0.5);
  });

  it("skips a value equal to the last one sent or the saved one", () => {
    const send = vi.fn();
    const skipped = vi.fn();
    const c = debouncedCommit<number>(send, 400, 0.2, skipped);
    c.push(0.2); // the saved value
    c.flush();
    expect(send).not.toHaveBeenCalled();
    expect(skipped).toHaveBeenCalledWith(0.2);
    c.push(0.4);
    c.flush();
    c.push(0.4);
    c.flush();
    expect(send).toHaveBeenCalledTimes(1);
    // the saved value changed elsewhere (e.g. undo back to 0.2): moving to 0.4 again is a real change
    c.known(0.2);
    c.push(0.4);
    c.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("after a rejected send the same value can be sent again; setSend swaps the sender", () => {
    const first = vi.fn();
    const second = vi.fn();
    const c = debouncedCommit<number>(first, 400, 0);
    c.push(0.3);
    c.flush();
    c.rejected();
    c.setSend(second);
    c.push(0.3);
    c.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(0.3);
  });

  it("cancel drops a pending value", () => {
    const send = vi.fn();
    const c = debouncedCommit<number>(send, 400, 0);
    c.push(1);
    c.cancel();
    vi.advanceTimersByTime(1000);
    c.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
