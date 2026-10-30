import { describe, expect, it } from "vitest";
import { briefingToMarkdown, formatMinutes } from "./briefingText.ts";
import type { BriefingContent, TranslatedBriefingContent } from "./analysisTypes.ts";

const topics = [
  { id: "t1", title: "Housing costs", summary: "Rents.", startMs: 0, endMs: 240_000 },
  { id: "t2", title: "Public transport", summary: "Trams and fares.", startMs: 240_000, endMs: 3_900_000 },
];
const moments = [
  { id: "m1", startMs: 83_000 },
  { id: "m2", startMs: 3_700_500 },
];
const briefing: BriefingContent = {
  lead: [
    { text: "The mayor promised new homes.", momentIds: ["m1"] },
    { text: "He apologised for the tram delay.", momentIds: ["m2"] },
  ],
  sections: [
    { topicId: "t1", summary: [{ text: "Why rents rose.", momentIds: ["m1"] }], keyQuote: { momentId: "m1", text: "We will approve twelve thousand homes." } },
    { topicId: "t2", summary: [{ text: "The tram is late.", momentIds: ["m2"] }], keyQuote: null },
  ],
};

describe("briefingToMarkdown", () => {
  it("briefingToMarkdown includes timestamps and translations after originals", () => {
    const md = briefingToMarkdown({ title: "Mayor interview", durationMs: 3_900_000, briefing, topics, moments });
    expect(md.startsWith("# Mayor interview\n")).toBe(true);
    expect(md).toContain("The mayor promised new homes. He apologised for the tram delay.");
    expect(md).toContain("## 1 · Housing costs (00:00:00 · 4m)");
    expect(md).toContain("## 2 · Public transport (00:04:00 · 61m)");
    expect(md).toContain('> "We will approve twelve thousand homes." — [00:01:23]');
    expect(md.indexOf("The mayor promised")).toBeLessThan(md.indexOf("## 1 · Housing costs"));
    expect(md.indexOf("Why rents rose.")).toBeGreaterThan(md.indexOf("## 1 · Housing costs"));
    expect(md.indexOf("The tram is late.")).toBeGreaterThan(md.indexOf("## 2 · Public transport"));

    const translation: TranslatedBriefingContent = {
      lead: [{ text: "O presidente prometeu casas.", momentIds: ["m1"] }],
      sections: [
        {
          topicId: "t1",
          summary: [{ text: "Porque subiram as rendas.", momentIds: ["m1"] }],
          keyQuote: { momentId: "m1", original: "We will approve twelve thousand homes.", translation: "Vamos aprovar doze mil casas." },
        },
      ],
    };
    const tr = briefingToMarkdown({ title: "Mayor interview", durationMs: 3_900_000, briefing, topics, moments, translation });
    const after = (a: string, b: string) => expect(tr.indexOf(a)).toBeGreaterThan(tr.indexOf(b));
    after("O presidente prometeu casas.", "He apologised for the tram delay.");
    expect(tr.indexOf("O presidente prometeu casas.")).toBeLessThan(tr.indexOf("## 1 · Housing costs"));
    after("Porque subiram as rendas.", "Why rents rose.");
    after('"Vamos aprovar doze mil casas."', '> "We will approve twelve thousand homes." — [00:01:23]');
    expect(tr.indexOf('"Vamos aprovar doze mil casas."')).toBeLessThan(tr.indexOf("## 2 · Public transport"));
  });

  it("falls back to topic summaries without a briefing", () => {
    const md = briefingToMarkdown({ title: "T", durationMs: 3_900_000, briefing: null, topics, moments });
    expect(md).toContain("## 1 · Housing costs (00:00:00 · 4m)\n\nRents.");
    expect(md).not.toContain(">");
  });

  it("formatMinutes rounds and never shows 0m", () => {
    expect(formatMinutes(240_000)).toBe("4m");
    expect(formatMinutes(89_000)).toBe("1m");
    expect(formatMinutes(20_000)).toBe("1m");
  });
});
