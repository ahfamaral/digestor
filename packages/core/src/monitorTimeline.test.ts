import { describe, expect, it } from "vitest";
import { inOfficePeriods, partyTimeline, type HistoryRow } from "./monitorTimeline.ts";

const h = (at: string, party: string | null, status: string | null, description = ""): HistoryRow => ({ at, party, uf: "AL", status, description });
const gaspar = [
  h("2023-02-01T00:00", "UNIÃO", null, "Nome no início da legislatura / Partido no início da legislatura"),
  h("2023-02-01T12:05", "UNIÃO", "Exercício", "Entrada - Posse de Eleito Titular - Posse na Sessão Preparatória"),
  h("2026-04-29T22:10", "PL", "Exercício", "Alteração de partido"),
];

describe("partyTimeline", () => {
  it("one band per party while in office", () => {
    expect(partyTimeline(gaspar).map(({ party, from, to, inOffice }) => ({ party, from, to, inOffice }))).toEqual([
      { party: "UNIÃO", from: "2023-02-01", to: "2026-04-29", inOffice: true },
      { party: "PL", from: "2026-04-29", to: null, inOffice: true },
    ]);
  });

  it("a leave is an out-of-office band with its description", () => {
    const rows = [
      h("2023-02-01T12:05", "PT", "Exercício", "Entrada - Posse"),
      h("2025-03-03T10:00", "PT", "Afastado", "Afastamento - Investidura no cargo de Ministro"),
      h("2025-04-01T09:00", "PT", "Exercício", "Reassunção"),
    ];
    const bands = partyTimeline(rows);
    expect(bands.map((b) => [b.from, b.to, b.inOffice])).toEqual([
      ["2023-02-01", "2025-03-03", true], ["2025-03-03", "2025-04-01", false], ["2025-04-01", null, true],
    ]);
    expect(bands[1]!.description).toBe("Afastamento - Investidura no cargo de Ministro");
    expect(inOfficePeriods(bands)).toEqual([{ from: "2023-02-01", to: "2025-03-03" }, { from: "2025-04-01", to: null }]);
  });

  it("rows before the legislature are clipped to it; no rows, no bands", () => {
    expect(partyTimeline([h("2019-02-01T10:00", "PSOL", "Exercício")])[0]!.from).toBe("2023-02-01");
    expect(partyTimeline([])).toEqual([]);
  });
});
