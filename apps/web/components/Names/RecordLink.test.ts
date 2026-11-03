import { describe, expect, it } from "vitest";
import { recordMatchedLine } from "@/lib/names";
import { recordFieldError } from "./RecordLink";

describe("the official record field and its status lines", () => {
  it("accepts a Senado date, a Senado link with its date and a Câmara event link", () => {
    expect(recordFieldError("2026-10-21")).toBeNull();
    expect(recordFieldError("https://www25.senado.leg.br/web/atividade/plenario/-/sessao/123 2026-10-21")).toBeNull();
    expect(recordFieldError("https://www.camara.leg.br/evento-legislativo/82635")).toBeNull();
  });
  it("names all three forms when the text is none of them", () => {
    const line = recordFieldError("hello")!;
    expect(line).toContain("Senado session date");
    expect(line).toContain("Senado session link with its date");
    expect(line).toContain("https://www.camara.leg.br/evento-legislativo/<id>");
  });
  it("shows the matched line of each chamber", () => {
    expect(recordMatchedLine({ chamber: "senado", date: "21/10/2026" })).toBe("Names from the Senado record of 21/10/2026");
    expect(recordMatchedLine({ chamber: "camara", date: null })).toBe("Names from the Câmara record");
  });
});
