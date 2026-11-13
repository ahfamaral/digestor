import { describe, expect, it } from "vitest";
import { rrf } from "./rrf.ts";

describe("rrf", () => {
  it("an item in both lists beats items in one", () => {
    const out = rrf([
      ["a", "b", "c"],
      ["x", "c", "y"],
    ]);
    expect(out[0]!.key).toBe("c");
    expect(out[0]!.inLists).toEqual([0, 1]);
    expect(out[0]!.score).toBeCloseTo(1 / 63 + 1 / 62, 10);
  });

  it("ties keep the first list's order, then the second's", () => {
    const out = rrf([
      ["a", "b"],
      ["x", "y"],
    ]);
    // a and x tie at rank 1, b and y at rank 2: the first list's item first.
    expect(out.map((r) => r.key)).toEqual(["a", "x", "b", "y"]);
    expect(out.find((r) => r.key === "y")!.inLists).toEqual([1]);
  });

  it("uses k (default 60) and ignores a repeated key inside one list", () => {
    expect(rrf([["a"]])[0]!.score).toBeCloseTo(1 / 61, 10);
    expect(rrf([["a"]], 0)[0]!.score).toBe(1);
    const out = rrf([["a", "a", "b"]]);
    expect(out.map((r) => r.key)).toEqual(["a", "b"]);
    expect(out[1]!.score).toBeCloseTo(1 / 63, 10);
  });

  it("empty lists give nothing", () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([[], []])).toEqual([]);
  });
});
