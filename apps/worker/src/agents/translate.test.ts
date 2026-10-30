import { describe, expect, it } from "vitest";
import { FakeLLM } from "../llm/structured.js";
import { MissingApiKeyError } from "../errors.js";
import { normalizeTranslation, translateCues } from "./translate.js";

describe("normalizeTranslation", () => {
  it("maps by index and flags gaps", () => {
    const r = normalizeTranslation(["a", "b", "c"], { lines: [{ n: 1, text: "A" }, { n: 3, text: "C" }, { n: 7, text: "X" }] });
    expect(r).toEqual([{ text: "A", missing: false }, { text: "", missing: true }, { text: "C", missing: false }]);
  });
  it("treats blank text as missing", () => {
    expect(normalizeTranslation(["a"], { lines: [{ n: 1, text: "  " }] })).toEqual([{ text: "", missing: true }]);
  });
});

describe("translateCues", () => {
  const echo = (c: { user: string }) => ({
    lines: [...c.user.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: `T${m[2]}` })),
  });
  it("batches at 80 lines, numbering each batch from 1", async () => {
    const lines = Array.from({ length: 170 }, (_, i) => `l${i}`);
    const llm = new FakeLLM({ byName: { translate_cues: [echo, echo, echo] } });
    const r = await translateCues(llm, { from: "en", to: "pt", lines });
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls.every((c) => c.model === "fast")).toBe(true);
    expect(r).toHaveLength(170);
    expect(r[169]).toEqual({ text: "Tl169", missing: false });
    expect(llm.calls[2]!.user).toContain("1. l160");
  });
  it("rethrows a missing key", async () => {
    const llm = new FakeLLM({ byName: { translate_cues: [() => { throw new MissingApiKeyError("ANTHROPIC_API_KEY"); }] } });
    await expect(translateCues(llm, { from: "en", to: "pt", lines: ["a"] })).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});
