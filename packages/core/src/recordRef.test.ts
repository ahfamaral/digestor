import { describe, expect, it } from "vitest";
import { parseRecordRef, recordRefDate } from "./recordRef.ts";

describe("parseRecordRef", () => {
  it("accepts the confirmed Senado and Câmara URLs and a date, rejects others", () => {
    const page = "https://www25.senado.leg.br/web/atividade/plenario/-/sessao/513336";
    expect(parseRecordRef("2025-10-21")).toMatchObject({ chamber: "senado", date: "2025-10-21", sessionCode: null });
    expect(parseRecordRef(" 21/10/2025 ")).toMatchObject({ chamber: "senado", date: "2025-10-21", sessionCode: null });
    expect(parseRecordRef(`${page} 2025-10-21`)).toEqual({ chamber: "senado", date: "2025-10-21", sessionCode: "513336", url: page });
    expect(parseRecordRef(`21/10/2025 ${page}/`)).toMatchObject({ date: "2025-10-21", sessionCode: "513336" });
    expect(parseRecordRef("https://www.camara.leg.br/evento-legislativo/76000")).toEqual({
      chamber: "camara", eventId: "76000", url: "https://www.camara.leg.br/evento-legislativo/76000",
    });
    expect(parseRecordRef("camara.leg.br/evento-legislativo/76000?x=1")).toMatchObject({ chamber: "camara", eventId: "76000" });
    // rejected
    expect(parseRecordRef(page)).toBeNull(); // the page URL has no date
    expect(parseRecordRef("https://www25.senado.leg.br/web/atividade/sessoes-plenarias/-/sessao/513336 2025-10-21")).toBeNull();
    expect(parseRecordRef("https://example.com/evento-legislativo/76000")).toBeNull();
    expect(parseRecordRef("https://www.camara.leg.br/evento-legislativo/abc")).toBeNull();
    expect(parseRecordRef("https://www.camara.leg.br/evento-legislativo/76000 2025-10-21")).toBeNull();
    expect(parseRecordRef("2025-02-30")).toBeNull();
    expect(parseRecordRef("2025-10-21 2025-10-22")).toBeNull();
    expect(parseRecordRef("")).toBeNull();
    expect(parseRecordRef("hello")).toBeNull();
    expect(parseRecordRef("javascript:alert(1)")).toBeNull();
  });

  it("shows the date as the journalist reads it", () => {
    expect(recordRefDate(parseRecordRef("2025-10-21")!)).toBe("21/10/2025");
    expect(recordRefDate(parseRecordRef("https://www.camara.leg.br/evento-legislativo/76000")!)).toBeNull();
  });
});
