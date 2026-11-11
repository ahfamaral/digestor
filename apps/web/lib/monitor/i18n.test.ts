import { describe, expect, it } from "vitest";
import { monitorEn, monitorPtBR } from "@/messages/monitor";
import { formatSpeechTime, monitorLocale, tm } from "./i18n";

describe("monitor i18n", () => {
  it("tm interpolates like t()", () => {
    expect(tm("en", "search.searchedFor", { terms: "feminicídio" })).toBe("Searched for: feminicídio");
    expect(tm("en", "title")).toBe("Câmara monitor");
  });

  it("monitorLocale: a valid cookie wins, else the browser's language", () => {
    expect(monitorLocale(undefined, "pt-BR,pt;q=0.9")).toBe("pt-BR");
    expect(monitorLocale(undefined, "pt-PT")).toBe("pt-BR");
    expect(monitorLocale("en", "pt-BR")).toBe("en");
    expect(monitorLocale("pt-BR", "de-DE")).toBe("pt-BR");
    expect(monitorLocale("xx", null)).toBe("en");
    expect(monitorLocale(undefined, "de-DE,en;q=0.8")).toBe("en");
    expect(monitorLocale(undefined, null)).toBe("en");
  });

  it("both catalogues have the same keys", () => {
    const keys = (o: object, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [`${p}${k}`] : keys(v as object, `${p}${k}.`)));
    expect(keys(monitorPtBR).sort()).toEqual(keys(monitorEn).sort());
    expect(tm("pt-BR", "title")).toBe("Monitor da Câmara");
    expect(tm("pt-BR", "search.searchedFor", { terms: "feminicídio" })).toBe("Buscado: feminicídio");
  });

  it("formats a Brasília wall-clock time without shifting it", () => {
    expect(formatSpeechTime("2026-03-17T18:00", "en")).toMatch(/Mar 17, 2026.*6:00/);
  });
});
