import { describe, expect, it } from "vitest";
import { billRowLabel, billTypeFeminine } from "./billTypes";

describe("billRowLabel", () => {
  const prl = { type: "PRL", number: 1, year: 0, mainBillLabel: "PL 1761/2025" };
  it("names an item numbered inside its main bill with that bill, never with /0", () => {
    expect(billRowLabel("en", prl)).toBe("PRL 1 on PL 1761/2025");
    expect(billRowLabel("pt-BR", prl)).toBe("PRL 1 sobre o PL 1761/2025");
    expect(billRowLabel("pt-BR", { ...prl, mainBillLabel: "PEC 3/2021" })).toBe("PRL 1 sobre a PEC 3/2021");
    expect(billRowLabel("en", { ...prl, mainBillLabel: null })).toBe("PRL 1");
    expect(billRowLabel("en", { type: "SBR", number: 2, year: 0 })).toBe("SBR 2");
  });
  it("a dated bill keeps its own label, even when it is attached to another", () => {
    expect(billRowLabel("en", { type: "PL", number: 5330, year: 2026, mainBillLabel: "PL 1/2020" })).toBe("PL 5330/2026");
  });
  it("knows the gender of the main types", () => {
    expect(billTypeFeminine("PEC")).toBe(true);
    expect(billTypeFeminine("MPV")).toBe(true);
    expect(billTypeFeminine("PL")).toBe(false);
    expect(billTypeFeminine("XYZ")).toBe(false);
  });
});
