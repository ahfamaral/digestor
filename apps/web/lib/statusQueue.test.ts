import { describe, expect, it, vi } from "vitest";
import type { ClipStatus } from "@digestor/core";
import { StatusQueue } from "./statusQueue";

/** A send() whose calls stay pending until the test resolves or rejects them, in order. */
function harness() {
  const calls: { status: ClipStatus; resolve(): void; reject(e: Error): void }[] = [];
  const send = vi.fn(
    (_id: string, status: ClipStatus) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ status, resolve, reject });
      }),
  );
  const shown: ClipStatus[] = [];
  const errors: (string | null)[] = [];
  const q = new StatusQueue({
    send,
    onDisplay: (_id, s) => shown.push(s),
    onError: (_id, m) => errors.push(m),
  });
  const ui = () => shown[shown.length - 1];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { q, send, calls, shown, errors, ui, flush };
}

describe("StatusQueue", () => {
  it("sends one change and clears any error on success", async () => {
    const h = harness();
    h.q.set("c1", "approved", "proposed");
    expect(h.ui()).toBe("approved");
    expect(h.q.pending("c1")).toBe("approved");
    h.calls[0]!.resolve();
    await h.flush();
    expect(h.send.mock.calls).toEqual([["c1", "approved"]]);
    expect(h.ui()).toBe("approved");
    expect(h.errors).toEqual([null]);
    expect(h.q.pending("c1")).toBeUndefined();
  });

  it("A then R quickly: one request in flight, the final request is R and the UI ends at R", async () => {
    const h = harness();
    h.q.set("c1", "approved", "proposed");
    h.q.set("c1", "rejected", "approved");
    expect(h.send).toHaveBeenCalledTimes(1); // R waits for A to settle
    expect(h.ui()).toBe("rejected");
    h.calls[0]!.resolve(); // the stale A response must not repaint the UI
    await h.flush();
    expect(h.ui()).toBe("rejected");
    expect(h.send.mock.calls.map((c) => c[1])).toEqual(["approved", "rejected"]);
    h.calls[1]!.resolve();
    await h.flush();
    expect(h.ui()).toBe("rejected");
    expect(h.shown).toEqual(["approved", "rejected"]);
    expect(h.q.pending("c1")).toBeUndefined();
  });

  it("keeps only the newest desired value while one is in flight", async () => {
    const h = harness();
    h.q.set("c1", "approved", "proposed");
    h.q.set("c1", "neutral", "approved");
    h.q.set("c1", "rejected", "neutral");
    h.calls[0]!.resolve();
    await h.flush();
    h.calls[1]!.resolve();
    await h.flush();
    expect(h.send.mock.calls.map((c) => c[1])).toEqual(["approved", "rejected"]);
  });

  it("first fails while the second is pending: the UI rolls back to the server-confirmed value and shows the error", async () => {
    const h = harness();
    h.q.set("c1", "approved", "proposed");
    h.q.set("c1", "rejected", "approved");
    h.calls[0]!.reject(new Error("Server down"));
    await h.flush();
    expect(h.ui()).toBe("proposed");
    expect(h.errors).toEqual(["Server down"]);
    expect(h.send).toHaveBeenCalledTimes(1); // the pending R is dropped
    expect(h.q.pending("c1")).toBeUndefined();
  });

  it("a later failure rolls back to the value the server confirmed earlier", async () => {
    const h = harness();
    h.q.set("c1", "approved", "proposed");
    h.q.set("c1", "rejected", "approved");
    h.calls[0]!.resolve();
    await h.flush();
    h.calls[1]!.reject(new Error("nope"));
    await h.flush();
    expect(h.ui()).toBe("approved");
    expect(h.errors).toEqual(["nope"]);
  });

  it("returning to the confirmed value while in flight sends it back after the first settles", async () => {
    const h = harness();
    h.q.set("c1", "approved", "proposed");
    h.q.set("c1", "proposed", "approved");
    h.calls[0]!.resolve();
    await h.flush();
    expect(h.send.mock.calls.map((c) => c[1])).toEqual(["approved", "proposed"]);
    h.calls[1]!.resolve();
    await h.flush();
    expect(h.ui()).toBe("proposed");
  });

  it("ignores a no-op change and keeps clips independent", async () => {
    const h = harness();
    h.q.set("c1", "proposed", "proposed");
    expect(h.send).not.toHaveBeenCalled();
    h.q.set("c1", "approved", "proposed");
    h.q.set("c2", "rejected", "proposed");
    expect(h.send.mock.calls).toEqual([
      ["c1", "approved"],
      ["c2", "rejected"],
    ]);
  });
});
