import { describe, expect, it } from "vitest";
import { MIN_TENTHS, sumCounts, voteSegments } from "./voteBar";

const total = (segs: { tenths: number }[]) => segs.reduce((s, x) => s + x.tenths, 0);

describe("voteSegments", () => {
  it("orders segments as the page does and folds unknown labels into other", () => {
    const segs = voteSegments([
      { vote: "Artigo 17", n: 1 }, { vote: "Não", n: 3 }, { vote: "Sim", n: 5 }, { vote: "Ausente", n: 1 }, { vote: "Obstrução", n: 2 }, { vote: "Abstenção", n: 1 },
    ]);
    expect(segs.map((s) => s.key)).toEqual(["Sim", "Não", "Abstenção", "Obstrução", "Artigo 17", "other"]);
    expect(segs.at(-1)).toMatchObject({ key: "other", votes: ["Ausente"], n: 1 });
  });

  it("widths sum to exactly 100.0% when thirds don't divide evenly", () => {
    const segs = voteSegments([{ vote: "Sim", n: 1 }, { vote: "Não", n: 1 }, { vote: "Abstenção", n: 1 }]);
    expect(total(segs)).toBe(1000);
    expect(segs.map((s) => s.tenths)).toEqual([334, 333, 333]);
  });

  it("is proportional within the row, whatever the row's size", () => {
    expect(voteSegments([{ vote: "Sim", n: 2 }, { vote: "Não", n: 2 }]).map((s) => s.tenths)).toEqual([500, 500]);
    expect(voteSegments([{ vote: "Sim", n: 200 }, { vote: "Não", n: 200 }]).map((s) => s.tenths)).toEqual([500, 500]);
    expect(voteSegments([{ vote: "Não", n: 7 }])).toEqual([{ key: "Não", votes: ["Não"], n: 7, tenths: 1000 }]);
  });

  it("a single vote among hundreds stays visible, the widest segment gives way, and the sum stays 100%", () => {
    const segs = voteSegments([{ vote: "Sim", n: 11 }, { vote: "Não", n: 387 }, { vote: "Artigo 17", n: 1 }]);
    expect(total(segs)).toBe(1000);
    expect(segs.find((s) => s.key === "Artigo 17")!.tenths).toBe(MIN_TENTHS);
    expect(segs.find((s) => s.key === "Sim")!.tenths).toBe(28);
    expect(segs.find((s) => s.key === "Não")!.tenths).toBe(962);
  });

  it("skips zero counts; no votes is no bar", () => {
    expect(voteSegments([{ vote: "Sim", n: 0 }, { vote: "Não", n: 4 }]).map((s) => s.key)).toEqual(["Não"]);
    expect(voteSegments([])).toEqual([]);
  });
});

describe("sumCounts", () => {
  it("adds each label over the parties", () => {
    const sum = sumCounts([{ counts: [{ vote: "Sim", n: 2 }, { vote: "Não", n: 1 }] }, { counts: [{ vote: "Sim", n: 3 }] }]);
    expect(sum).toEqual([{ vote: "Sim", n: 5 }, { vote: "Não", n: 1 }]);
  });
});
