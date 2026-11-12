import { describe, expect, it } from "vitest";
import { monitorTitle } from "./titles";

describe("monitorTitle", () => {
  it("names the page first, then the monitor and the app", () => {
    expect(monitorTitle("en")).toBe("Câmara monitor · Digestor");
    expect(monitorTitle("en", "saúde")).toBe("saúde · Câmara monitor · Digestor");
    expect(monitorTitle("pt-BR", "Fernanda Melchionna")).toBe("Fernanda Melchionna · Monitor da Câmara · Digestor");
    expect(monitorTitle("en", "", null, "  ")).toBe("Câmara monitor · Digestor");
  });
});
