import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { recordMatchedLine } from "@/lib/names";
import { recordFieldError } from "./RecordLink";
import { RecordHouseSelect, recordHelpText, recordHouseGroups } from "./RecordHouseSelect";

describe("the official record field and its status lines", () => {
  it("accepts a Senado date, a Senado link with its date and a Câmara event link", () => {
    expect(recordFieldError("2026-10-21")).toBeNull();
    expect(recordFieldError("https://www25.senado.leg.br/web/atividade/plenario/-/sessao/123 2026-10-21")).toBeNull();
    expect(recordFieldError("https://www.camara.leg.br/evento-legislativo/82635")).toBeNull();
  });
  it("reads the text with the picked house", () => {
    expect(recordFieldError("21/103")).not.toBeNull();
    expect(recordFieldError("21/103", "bundestag")).toBeNull();
    expect(recordFieldError("10/21/2026", "us_senate")).toBeNull();
  });
  it("says to pick the house when the text is none of the forms", () => {
    expect(recordFieldError("hello")).toBe("Pick the house and paste the date, the sitting number or the official record link.");
  });
  it("answers a YouTube link with its own line", () => {
    expect(recordFieldError("https://youtu.be/dQw4w9WgXcQ")).toBe("Paste the date or the official record link.");
  });
  it("shows the matched line of each chamber", () => {
    expect(recordMatchedLine({ chamber: "senado", date: "21/10/2026" })).toBe("Names from the Senado record of 21/10/2026");
    expect(recordMatchedLine({ chamber: "camara", date: null })).toBe("Names from the Câmara record");
    expect(recordMatchedLine({ chamber: "bundestag", date: "16/10/2026" })).toBe("Names from the Bundestag record of 16/10/2026");
    expect(recordMatchedLine({ chamber: "bundestag", date: null })).toBe("Names from the Bundestag record");
  });
});

describe("the house select", () => {
  it("lists Detect from the link, then the five houses grouped by country", () => {
    const { detect, groups } = recordHouseGroups();
    expect(detect).toEqual({ value: "", label: "Detect from the link" });
    expect(groups.map((g) => g.country)).toEqual(["Brazil", "Germany", "USA"]);
    expect(groups.flatMap((g) => g.options)).toEqual([
      { value: "camara", label: "Câmara" },
      { value: "senado", label: "Senado" },
      { value: "bundestag", label: "Bundestag (Germany)" },
      { value: "us_house", label: "House (USA)" },
      { value: "us_senate", label: "Senate (USA)" },
    ]);
  });
  it("changes its help text with the house", () => {
    const texts = ["", "camara", "senado", "bundestag", "us_house", "us_senate"].map((h) => recordHelpText(h as never));
    expect(new Set(texts).size).toBe(6);
    expect(recordHelpText("bundestag")).toContain("21/103");
    expect(recordHelpText("us_house")).toContain("10/21/2026");
    expect(recordHelpText("senado")).toContain("2026-10-21");
    expect(recordHelpText("camara")).toContain("evento-legislativo");
  });
});

describe("the house select's accessible name", () => {
  it("has a visible label \"House\" tied to the select", () => {
    const html = renderToStaticMarkup(createElement(RecordHouseSelect, { id: "record-house-x", value: "", onChange: () => {} }));
    expect(html).toMatch(/<label[^>]*for="record-house-x"[^>]*>House<\/label>/);
    expect(html).toMatch(/<select[^>]*id="record-house-x"/);
  });
});
