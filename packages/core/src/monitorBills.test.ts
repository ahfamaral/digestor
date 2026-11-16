import { describe, expect, it } from "vitest";
import { billLabel, idFromUri } from "./monitorBills.ts";

describe("billLabel", () => {
  it("drops the year 0 of items numbered inside their main bill", () => {
    expect(billLabel("PL", 1761, 2025)).toBe("PL 1761/2025");
    expect(billLabel("PRL", 1, 0)).toBe("PRL 1");
    expect(billLabel("SBR", 2, 0)).not.toContain("/0");
  });
});

describe("idFromUri", () => {
  it("reads the id at the end of an API link", () => {
    expect(idFromUri("https://dadosabertos.camara.leg.br/api/v2/proposicoes/2636921")).toBe(2636921);
    expect(idFromUri("")).toBeNull();
    expect(idFromUri(null)).toBeNull();
    expect(idFromUri("https://dadosabertos.camara.leg.br/api/v2/proposicoes/")).toBeNull();
  });
});
