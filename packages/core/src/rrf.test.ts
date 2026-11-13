import { describe, expect, it } from "vitest";
import { fuseRecords, rrf } from "./rrf.ts";

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

describe("fuseRecords", () => {
  const o = { top: 2, min: 0.8 };
  it("word matches always come first (RRF only lifts the word matches meaning found too); meaning-only hits follow, in meaning order", () => {
    const words = ["w1", "w2", "w3", "m1"];
    const meaning = [{ id: "m2", score: 0.9 }, { id: "m1", score: 0.89 }, { id: "m3", score: 0.88 }, { id: "m4", score: 0.5 }];
    const r = fuseRecords(words, meaning, { top: 2, min: 0.8 });
    // m1 is a word match the meaning search found too: both lists rank it, so it rises to the top (1/64 + 1/62 > 1/61);
    // m3 is beyond `top`, m4 under the floor
    expect(r.list).toEqual(["m1", "w1", "w2", "w3", "m2"]);
    expect(r.meaningOnly).toEqual(["m2"]);
    // a meaning-only hit never comes before any word match, even beyond `fuse`
    expect(fuseRecords(["w1", "w2", "w3"], [{ id: "x", score: 0.95 }], { top: 5, min: 0, fuse: 2 }).list).toEqual(["w1", "w2", "w3", "x"]);
  });

  it("no meaning hits: the words as they are; no words: the meaning hits", () => {
    expect(fuseRecords(["a", "b"], [], o)).toEqual({ list: ["a", "b"], meaningOnly: [] });
    expect(fuseRecords([], [{ id: "x", score: 0.95 }, { id: "y", score: 0.7 }], o)).toEqual({ list: ["x"], meaningOnly: ["x"] });
  });

  it("`within`: only hits close to the best one (scores bunch together, so a fixed floor alone keeps too many)", () => {
    const meaning = [{ id: "a", score: 0.86 }, { id: "b", score: 0.84 }, { id: "c", score: 0.82 }, { id: "d", score: 0.6 }];
    expect(fuseRecords([], meaning, { top: 10, min: 0.75, within: 0.03 }).list).toEqual(["a", "b"]);
    expect(fuseRecords([], meaning, { top: 10, min: 0.85, within: 0.03 }).list).toEqual(["a"]);
    // the defaults
    expect(fuseRecords([], meaning).list).toEqual(["a", "b"]);
  });
});
