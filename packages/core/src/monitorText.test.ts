import { describe, expect, it } from "vitest";
import { normName, splitHighlights } from "./monitorText.ts";

describe("monitorText", () => {
  it("normName lower-cases, strips accents and collapses spaces", () => {
    expect(normName("  Fernanda   MELCHIONNA ")).toBe("fernanda melchionna");
    expect(normName("Máximo")).toBe("maximo");
  });

  it("splitHighlights splits on the ts_headline markers", () => {
    expect(splitHighlights("a \u0001b\u0002 c")).toEqual([
      { text: "a ", hit: false }, { text: "b", hit: true }, { text: " c", hit: false },
    ]);
    expect(splitHighlights("")).toEqual([]);
    expect(splitHighlights("\u0001x\u0002")).toEqual([{ text: "x", hit: true }]);
  });
});
