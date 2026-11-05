import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { recordMatchedLine } from "@/lib/names";
import { RecordStatusLine, RecordSuggestion, recordFieldError, recordPollMs, suggestionShown } from "./RecordLink";
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
    expect(recordMatchedLine({ chamber: "camara", date: "30/06/2026" })).toBe("Names from the Câmara record of 30/06/2026");
    expect(recordMatchedLine({ chamber: "bundestag", date: "16/10/2026" })).toBe("Names from the Bundestag record of 16/10/2026");
    expect(recordMatchedLine({ chamber: "bundestag", date: null })).toBe("Names from the Bundestag record");
  });
});

describe("the status line", () => {
  const html = (record: Parameters<typeof RecordStatusLine>[0]["record"]) => renderToStaticMarkup(createElement(RecordStatusLine, { record }));
  it("a waiting row shows the stored waiting line, not 'matching'", () => {
    const line = "The Bundestag hasn't published the record of sitting 104 yet. Digestor will check again. If there was no sitting that day, check the date.";
    const out = html({ status: "waiting", error: line, chamber: "bundestag", date: null, url: "x", retryAt: "2026-11-05T06:00:00.000Z" });
    expect(out).toContain("sitting 104");
    expect(out).not.toContain("Matching the official record");
  });
  it("a pending row says it is matching", () => {
    expect(html({ status: "pending", error: null, chamber: "senado", date: null, url: "x" })).toContain(t("names.record.matching"));
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
  it("has a visible label \"House\" tied to the dropdown", () => {
    const html = renderToStaticMarkup(createElement(RecordHouseSelect, { id: "record-house-x", value: "", onChange: () => {} }));
    expect(html).toMatch(/<label[^>]*for="record-house-x"[^>]*>House<\/label>/);
    expect(html).toMatch(/<button[^>]*id="record-house-x"/);
  });
});

describe("the suggestion", () => {
  const bundestag = { chamber: "bundestag" as const, period: 21, sitting: 104, date: "2026-10-16", url: "x" };
  const rec = { status: "suggested" as const, error: null, chamber: "bundestag" as const, date: "16/10/2026", url: "x", ref: bundestag };
  const html = (record: Parameters<typeof RecordSuggestion>[0]["record"], props: { busy?: boolean } = {}) =>
    renderToStaticMarkup(createElement(RecordSuggestion, { record, busy: props.busy ?? false, onAccept: () => {}, onDismiss: () => {} }));

  it("reads the sitting with its date and offers both buttons", () => {
    const out = html(rec);
    expect(out).toContain("This looks like the Bundestag sitting of 16/10/2026.");
    expect(out).toContain(">Use this record<");
    expect(out).toContain(">Not this one<");
  });
  it("reads the sitting number when the date is unknown", () => {
    const out = html({ ...rec, date: null, ref: { ...bundestag, date: null } });
    expect(out).toContain("This looks like the Bundestag sitting 104.");
  });
  it("shows only for a parliament session and a suggested row with its ref", () => {
    expect(suggestionShown(rec, "parliament")).toBe(true);
    expect(suggestionShown(rec, "interview")).toBe(false);
    expect(suggestionShown(rec, undefined)).toBe(false);
    expect(suggestionShown({ ...rec, status: "pending" as never }, "parliament")).toBe(false);
    expect(suggestionShown({ ...rec, ref: undefined }, "parliament")).toBe(false);
  });
});

describe("polling", () => {
  it("a waiting row is asked every 60 s, a working one every 3 s", () => {
    expect(recordPollMs("waiting")).toBe(60_000);
    expect(recordPollMs("pending")).toBe(3000);
    expect(recordPollMs("running")).toBe(3000);
  });
});

describe("a future date", () => {
  it("is refused with its own line", () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(recordFieldError(future)).toBe("That date is in the future. Check the date.");
  });
});
