import { describe, expect, it } from "vitest";
import { fightinWords } from "./fightinWords.ts";

const m = (o: Record<string, number>) => new Map(Object.entries(o));
const sum = (...maps: Map<string, number>[]) => {
  const out = new Map<string, number>();
  for (const x of maps) for (const [k, v] of x) out.set(k, (out.get(k) ?? 0) + v);
  return out;
};

describe("fightinWords", () => {
  // Hand-made corpus, both sides 50 words long.
  const target = m({ only: 10, shared: 20, other: 20 });
  const rest = m({ shared: 20, other: 30 });
  const prior = sum(target, rest);

  it("the word only the target uses ranks first", () => {
    const out = fightinWords(target, rest, prior);
    expect(out[0]).toMatchObject({ stem: "only", nTarget: 10 });
    expect(out[0]!.z).toBeGreaterThan(out[1]!.z);
  });

  it("a word used equally by both has z ≈ 0", () => {
    const shared = fightinWords(target, rest, prior).find((w) => w.stem === "shared")!;
    expect(Math.abs(shared.z)).toBeLessThan(0.05);
  });

  it("a word the target uses less than the rest has a negative z and comes last", () => {
    const out = fightinWords(target, rest, prior);
    expect(out.at(-1)!.stem).toBe("other");
    expect(out.at(-1)!.z).toBeLessThan(0);
  });

  it("the prior keeps a 1-count word below a 20-count one", () => {
    // Without a prior, "once" (1 vs 0) has infinite log-odds; "often" (20 vs 2) is the real signal.
    const t = m({ once: 1, often: 20, filler: 79 });
    const r = m({ often: 2, filler: 98 });
    const out = fightinWords(t, r, sum(t, r));
    expect(out.map((w) => w.stem).slice(0, 2)).toEqual(["often", "once"]);
    expect(out.every((w) => Number.isFinite(w.z))).toBe(true);
  });

  it("sorts by z descending and covers every word of either side", () => {
    const out = fightinWords(m({ a: 5, b: 1 }), m({ b: 5, c: 3 }), m({ a: 5, b: 6, c: 3 }), { alpha0: 50 });
    expect(out.map((w) => w.stem).sort()).toEqual(["a", "b", "c"]);
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.z).toBeGreaterThanOrEqual(out[i]!.z);
    expect(out.find((w) => w.stem === "c")!.nTarget).toBe(0);
  });

  it("empty input gives an empty list", () => {
    expect(fightinWords(new Map(), new Map(), new Map())).toEqual([]);
  });
});
