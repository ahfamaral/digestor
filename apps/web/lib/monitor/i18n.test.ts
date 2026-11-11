import { describe, expect, it } from "vitest";
import { formatSpeechTime, monitorLocale, tm } from "./i18n";

describe("monitor i18n", () => {
  it("tm interpolates like t()", () => {
    expect(tm("en", "search.searchedFor", { terms: "feminicídio" })).toBe("Searched for: feminicídio");
    expect(tm("en", "title")).toBe("Câmara monitor");
  });

  it("monitorLocale is English for now", () => {
    expect(monitorLocale(undefined, null)).toBe("en");
  });

  it("formats a Brasília wall-clock time without shifting it", () => {
    expect(formatSpeechTime("2026-03-17T18:00", "en")).toMatch(/Mar 17, 2026.*6:00/);
  });
});
