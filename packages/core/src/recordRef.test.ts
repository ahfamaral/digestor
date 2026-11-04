import { describe, expect, it } from "vitest";
import { parseRecordRef, recordInputError, recordRefDate } from "./recordRef.ts";

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

describe("parseRecordRef with a house", () => {
  const page = "https://www25.senado.leg.br/web/atividade/plenario/-/sessao/513336";
  const inputs = [
    "2025-10-21", " 21/10/2025 ", `${page} 2025-10-21`, `21/10/2025 ${page}/`,
    "https://www.camara.leg.br/evento-legislativo/76000", "camara.leg.br/evento-legislativo/76000?x=1",
    page, "https://www25.senado.leg.br/web/atividade/sessoes-plenarias/-/sessao/513336 2025-10-21",
    "https://example.com/evento-legislativo/76000", "https://www.camara.leg.br/evento-legislativo/abc",
    "https://www.camara.leg.br/evento-legislativo/76000 2025-10-21", "2025-02-30", "2025-10-21 2025-10-22",
    "", "hello", "javascript:alert(1)",
  ];
  it("Brazilian parity: no house, senado and camara (links) agree with today", () => {
    for (const input of inputs) {
      const base = parseRecordRef(input);
      expect(parseRecordRef(input, "senado"), input).toEqual(base);
      if (base && "eventId" in base) expect(parseRecordRef(input, "camara"), input).toEqual(base);
      if (base && "sessionCode" in base && base.sessionCode) expect(parseRecordRef(input, "camara"), input).toEqual(base);
    }
  });
  it("Bundestag: date, period/sitting", () => {
    expect(parseRecordRef("16/10/2026", "bundestag")).toMatchObject({ chamber: "bundestag", period: 21, sitting: null, date: "2026-10-16" });
    expect(parseRecordRef("21/103", "bundestag")).toMatchObject({ chamber: "bundestag", period: 21, sitting: 103, date: null });
    expect(parseRecordRef("2021-10-25", "bundestag")).toMatchObject({ period: 19 });
    expect(parseRecordRef("2021-10-26", "bundestag")).toMatchObject({ period: 20 });
    expect(parseRecordRef("2025-03-24", "bundestag")).toMatchObject({ period: 20 });
    expect(parseRecordRef("2025-03-25", "bundestag")).toMatchObject({ period: 21 });
    expect(parseRecordRef("2017-10-23", "bundestag")).toBeNull();
    expect(parseRecordRef("hello", "bundestag")).toBeNull();
  });
  it("Câmara day", () => {
    expect(parseRecordRef("2026-11-03", "camara")).toMatchObject({ chamber: "camara", date: "2026-11-03" });
    expect(parseRecordRef("03/11/2026", "camara")).toMatchObject({ chamber: "camara", date: "2026-11-03" });
  });
  it("US houses read MM/DD/YYYY, others DD/MM/YYYY", () => {
    expect(parseRecordRef("11/03/2026", "us_house")).toMatchObject({ chamber: "us_house", date: "2026-11-03" });
    expect(parseRecordRef("11/03/2026", "us_senate")).toMatchObject({ chamber: "us_senate", date: "2026-11-03" });
    expect(parseRecordRef("2026-11-03", "us_senate")).toMatchObject({ date: "2026-11-03" });
    expect(parseRecordRef("11/03/2026", "senado")).toMatchObject({ chamber: "senado", date: "2026-03-11" });
    expect(parseRecordRef("21/103", "us_house")).toBeNull();
  });
  it("a link decides its own house", () => {
    expect(parseRecordRef("https://www.camara.leg.br/evento-legislativo/82635", "bundestag")).toEqual({
      chamber: "camara", eventId: "82635", url: "https://www.camara.leg.br/evento-legislativo/82635",
    });
    expect(parseRecordRef("2026-11-03")).toMatchObject({ chamber: "senado" });
  });
  it("a slash date next to a Brazilian link is read DD/MM whatever house is selected", () => {
    const link = "https://www25.senado.leg.br/web/atividade/plenario/-/sessao/123";
    expect(parseRecordRef(`03/11/2026 ${link}`, "us_house")).toMatchObject({ chamber: "senado", date: "2026-11-03", sessionCode: "123" });
    expect(parseRecordRef(`03/11/2026 ${link}`)).toEqual(parseRecordRef(`03/11/2026 ${link}`, "us_house"));
    expect(parseRecordRef(`21/10/2025 ${link}`, "us_house")).toMatchObject({ chamber: "senado", date: "2025-10-21", sessionCode: "123" });
  });
  it("recordRefDate for any ref with a date", () => {
    expect(recordRefDate(parseRecordRef("2026-11-03", "us_house")!)).toBe("11/03/2026");
    expect(recordRefDate(parseRecordRef("2026-11-03", "us_senate")!)).toBe("11/03/2026");
    expect(recordRefDate(parseRecordRef("2026-11-03", "camara")!)).toBe("03/11/2026");
    expect(recordRefDate(parseRecordRef("16/10/2026", "bundestag")!)).toBe("16/10/2026");
    expect(recordRefDate(parseRecordRef("21/103", "bundestag")!)).toBeNull();
  });
});

describe("recordInputError", () => {
  it("rejects YouTube and Mediathek links with a friendly line, else null", () => {
    expect(recordInputError("https://www.youtube.com/watch?v=x")).toBe("Paste the date or the official record link.");
    expect(recordInputError("https://youtu.be/x")).toBe("Paste the date or the official record link.");
    expect(recordInputError("https://www.bundestag.de/mediathek/video?videoid=7612345")).toBe("Paste the date or sitting number instead.");
    expect(recordInputError("2026-11-03")).toBeNull();
    expect(recordInputError("https://www.camara.leg.br/evento-legislativo/1")).toBeNull();
  });
});
