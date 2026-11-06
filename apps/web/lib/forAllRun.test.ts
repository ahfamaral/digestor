import { describe, expect, it } from "vitest";
import { runForAll } from "./forAllRun";

describe("runForAll", () => {
  it("saves every clip in order and reports progress", async () => {
    const calls: string[] = [];
    const progress: number[] = [];
    const out = await runForAll(["a", "b", "c"], async (id) => (calls.push(id), true), (n) => progress.push(n));
    expect(calls).toEqual(["a", "b", "c"]);
    expect(progress).toEqual([1, 2, 3]);
    expect(out).toEqual({ ok: ["a", "b", "c"], failed: [], result: "all" });
  });

  it("one failure in the middle (false or thrown) does not stop the rest", async () => {
    const calls: string[] = [];
    const out = await runForAll(["a", "b", "c", "d"], async (id) => {
      calls.push(id);
      if (id === "b") return false;
      if (id === "c") throw new Error("raw");
      return true;
    });
    expect(calls).toEqual(["a", "b", "c", "d"]);
    expect(out).toEqual({ ok: ["a", "d"], failed: ["b", "c"], result: "partial" });
  });

  it("all failing", async () => {
    const out = await runForAll(["a", "b"], async () => false);
    expect(out).toEqual({ ok: [], failed: ["a", "b"], result: "none" });
  });

  it("calls one at a time", async () => {
    let running = 0;
    let max = 0;
    await runForAll(["a", "b", "c"], async () => {
      max = Math.max(max, ++running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return true;
    });
    expect(max).toBe(1);
  });
});
