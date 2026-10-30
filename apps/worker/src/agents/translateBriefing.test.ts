import { describe, expect, it } from "vitest";
import type { BriefingContent } from "@digestor/core";
import { FakeLLM } from "../llm/structured.js";
import { MissingApiKeyError } from "../errors.js";
import { translateBriefing } from "./translateBriefing.js";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const content: BriefingContent = {
  lead: [{ text: "The minister defended the budget.", momentIds: [M1] }],
  sections: [
    {
      topicId: "t1",
      summary: [{ text: "She cited 42 hospitals.", momentIds: [M1, M2] }, { text: "The opposition disagreed.", momentIds: [M2] }],
      keyQuote: { momentId: M1, text: "We will build 42 hospitals." },
    },
    { topicId: "t2", summary: [{ text: "A short vote followed.", momentIds: [M2] }], keyQuote: null },
  ],
};

const echo = (c: { user: string }) => ({
  lines: [...c.user.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: `PT:${m[2]}` })),
});

describe("translateBriefing", () => {
  it("translateBriefing keeps originals", async () => {
    const before = structuredClone(content);
    const llm = new FakeLLM({ byName: { translate_briefing: [echo] } });
    const out = await translateBriefing(llm, content, "pt");

    expect(content).toEqual(before); // the input is never mutated
    expect(out.lead).toEqual([{ text: "PT:The minister defended the budget.", momentIds: [M1] }]);
    expect(out.sections[0]!.topicId).toBe("t1");
    expect(out.sections[0]!.summary).toEqual([
      { text: "PT:She cited 42 hospitals.", momentIds: [M1, M2] },
      { text: "PT:The opposition disagreed.", momentIds: [M2] },
    ]);
    // quotes keep the verbatim original next to the translation; the id is copied
    expect(out.sections[0]!.keyQuote).toEqual({ momentId: M1, original: "We will build 42 hospitals.", translation: "PT:We will build 42 hospitals." });
    expect(out.sections[1]).toEqual({ topicId: "t2", summary: [{ text: "PT:A short vote followed.", momentIds: [M2] }], keyQuote: null });
    // one call, fast model; ids never reach the model
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.model).toBe("fast");
    expect(llm.calls[0]!.user).toContain("4. We will build 42 hospitals.");
    expect(llm.calls[0]!.user).not.toContain(M1);
    expect(llm.calls[0]!.system).toContain("Portuguese");
  });

  it("a skipped sentence keeps its original; a skipped quote has an empty translation; extra lines are ignored", async () => {
    const llm = new FakeLLM([{ lines: [{ n: 2, text: "T2" }, { n: 3, text: "T3" }, { n: 99, text: "junk" }] }]);
    const out = await translateBriefing(llm, content, "pt");
    expect(out.lead[0]!.text).toBe("The minister defended the budget."); // line 1 missing -> original
    expect(out.sections[0]!.summary.map((s) => s.text)).toEqual(["T2", "T3"]);
    expect(out.sections[0]!.keyQuote).toMatchObject({ original: "We will build 42 hospitals.", translation: "" });
    expect(out.sections[1]!.summary[0]!.text).toBe("A short vote followed.");
  });

  it("throws when nothing usable comes back, and rethrows a missing key", async () => {
    await expect(translateBriefing(new FakeLLM([{ lines: [] }]), content, "pt")).rejects.toThrow("no usable translation");
    const keyless = new FakeLLM({ byName: { translate_briefing: [() => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); }] } });
    await expect(translateBriefing(keyless, content, "pt")).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("an empty briefing makes no model call", async () => {
    const llm = new FakeLLM([]);
    expect(await translateBriefing(llm, { lead: [], sections: [] }, "pt")).toEqual({ lead: [], sections: [] });
    expect(llm.calls).toHaveLength(0);
  });
});
