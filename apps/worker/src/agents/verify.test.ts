import { describe, expect, it, vi } from "vitest";
import type { Word } from "@digestor/core";
import { FakeLLM } from "../llm/structured.js";
import { COULDNT_CONFIRM, JUDGE_SYSTEM, citedSentences, extractQuotes, findQuote, judgeClaims, verifyAnswer, withCouldntConfirm } from "./verify.js";

/** Words from a sentence, one per second from `startMs`. */
const wordsOf = (text: string, startMs = 0, speaker = "A"): Word[] =>
  text.split(" ").map((t, i) => ({ text: t, startMs: startMs + i * 1000, endMs: startMs + i * 1000 + 800, confidence: 0.9, speaker }));

describe("extractQuotes", () => {
  it("finds German „…“ quotes, curly and straight double quotes and « »", () => {
    const answer = `Sie sagte „Wir schaffen das, ganz sicher“ [00:01:00]. He said "rents are far too high" and “we will build more homes” [00:02:00]. Il a dit « nous allons construire des logements ».`;
    expect(extractQuotes(answer)).toEqual([
      "Wir schaffen das, ganz sicher",
      "rents are far too high",
      "we will build more homes",
      "nous allons construire des logements",
    ]);
  });

  it("ignores quotes of fewer than 4 words", () => {
    expect(extractQuotes(`She called it "a big lie" [00:00:10] and „das ist falsch“.`)).toEqual([]);
    expect(extractQuotes(`"one two three four"`)).toEqual(["one two three four"]);
  });
});

describe("findQuote", () => {
  const words = [...wordsOf("Good evening."), ...wordsOf("Rents rose again — sharply, in São Paulo!", 10_000), ...wordsOf("Não é verdade, senhor.", 30_000, "B")];

  it("finds a quote despite punctuation, case and accent differences, at its first word's time", () => {
    expect(findQuote("rents ROSE again, sharply", words)).toEqual({ found: true, atMs: 10_000 });
    expect(findQuote("sharply in sao paulo", words)).toEqual({ found: true, atMs: 14_000 }); // "—" is no word
    expect(findQuote("Nao e verdade senhor", words)).toEqual({ found: true, atMs: 30_000 });
    expect(findQuote("evening. Rents rose", words)).toEqual({ found: true, atMs: 1_000 }); // across sentences
  });

  it("does not find a quote with one word changed, or a partial word", () => {
    expect(findQuote("rents fell again sharply", words)).toEqual({ found: false, atMs: null });
    expect(findQuote("ents rose again sharply", words)).toEqual({ found: false, atMs: null });
    expect(findQuote("", words)).toEqual({ found: false, atMs: null });
  });
});

describe("citedSentences", () => {
  it("returns the sentences carrying [hh:mm:ss], with every time of a range, and skips the others", () => {
    const answer = "Rents rose [00:01:00]. The mayor disagreed. She said „Wir schaffen das. Ganz sicher.“ [00:02:10–00:02:20]";
    expect(citedSentences(answer)).toEqual([
      { text: "Rents rose [00:01:00].", atMs: [60_000] },
      { text: "She said „Wir schaffen das. Ganz sicher.“ [00:02:10–00:02:20]", atMs: [130_000, 140_000] },
    ]);
  });

  it("keeps a timestamp written after the full stop with its sentence, and splits list lines", () => {
    const answer = "Two points:\n- Rents rose. [00:00:05]\n- Wages fell [1:02:03; 01:02:30]\n- Nobody mentioned taxes.";
    expect(citedSentences(answer)).toEqual([
      { text: "- Rents rose. [00:00:05]", atMs: [5_000] },
      { text: "- Wages fell [1:02:03; 01:02:30]", atMs: [3_723_000, 3_750_000] },
    ]);
  });

  it("returns nothing for an answer without timestamps", () => {
    expect(citedSentences("That isn't in this video's data.")).toEqual([]);
  });
});

describe("judgeClaims", () => {
  const claims = [
    { text: "Rents rose [00:00:10].", window: "[00:00:10] A: Rents rose." },
    { text: "Wages fell [00:00:20].", window: "[00:00:20] A: Wages rose." },
    { text: "Taxes too [00:00:30].", window: "[00:00:30] A: Hm." },
  ];

  it("sends one fast call with every claim and its transcript window, and maps each verdict by number", async () => {
    const llm = new FakeLLM([
      {
        verdicts: [
          { claim: 2, reason: "It says wages rose.", verdict: "Unsupported" },
          { claim: 1, reason: "Said at 10 s.", verdict: "supported" },
          { claim: 3, reason: "?", verdict: "unclear" },
        ],
      },
    ]);
    expect(await judgeClaims(llm, claims)).toEqual([true, false, null]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toMatchObject({ name: "verify_claims", model: "fast" });
    expect(llm.calls[0]!.user).toContain("Claim 2: Wages fell [00:00:20].\nTranscript around it:\n<transcript>\n[00:00:20] A: Wages rose.\n</transcript>");
  });

  it("an odd item is skipped (number out of range, duplicate, unknown word): those claims stay unchecked", async () => {
    const llm = new FakeLLM([
      { verdicts: [{ claim: 7, reason: "", verdict: "unsupported" }, { claim: 1, reason: "", verdict: "maybe" }, { claim: 2, reason: "", verdict: "supported" }, { claim: 2, reason: "", verdict: "unsupported" }] },
    ]);
    expect(await judgeClaims(llm, claims)).toEqual([null, true, null]);
  });

  it("a failed call leaves every claim unchecked, never unsupported", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new FakeLLM([
      () => {
        throw new Error("529 overloaded");
      },
    ]);
    expect(await judgeClaims(failing, claims)).toEqual([null, null, null]);
    expect(await judgeClaims(new FakeLLM([{ verdicts: "nope" }]), claims)).toEqual([null, null, null]); // a reply off the schema
    err.mockRestore();
    expect(await judgeClaims(new FakeLLM([]), [])).toEqual([]); // nothing to judge: no call
  });
});

describe("verifyAnswer", () => {
  // German speech: one sentence every 10 s from 00:00:00, speaker A.
  const german = ["Wir schaffen das, sagte die Kanzlerin.", "Die Mieten sind viel zu hoch.", "Wir bauen mehr Wohnungen in Berlin."];
  const words = german.flatMap((s, i) => wordsOf(s, i * 10_000));
  const verdicts = (...v: string[]) => ({ verdicts: v.map((verdict, i) => ({ claim: i + 1, reason: "r", verdict })) });

  it("a quote found word for word passes without a judge call when no sentence cites a time", async () => {
    const llm = new FakeLLM([]);
    expect(await verifyAnswer({ judge: llm }, "Sie sagte „Die Mieten sind viel zu hoch“.", { words })).toEqual({ unsupported: [], unchecked: [], checked: 1, judgeFailed: false });
    expect(llm.calls).toHaveLength(0);
  });

  it("a misquote in the transcript's language is unsupported, without asking the judge", async () => {
    const llm = new FakeLLM([]);
    const r = await verifyAnswer({ judge: llm }, "Sie sagte „Die Mieten sind viel zu niedrig“.", { words });
    expect(r.unsupported).toEqual(["“Die Mieten sind viel zu niedrig”"]);
    expect(llm.calls).toHaveLength(0);
  });

  it("a quote in another language (an English rendering of German speech) is judged as a claim, not failed as a quote", async () => {
    const llm = new FakeLLM([verdicts("supported", "supported")]);
    const r = await verifyAnswer({ judge: llm }, `She said [00:00:10]:\n"The rents are far too high."`, { words });
    expect(r).toEqual({ unsupported: [], unchecked: [], checked: 2, judgeFailed: false });
    // The quote's own line cites nothing: it is judged against the window of the citing line before it.
    expect(llm.calls[0]!.user).toContain("Claim 2: She said [00:00:10]:");
    expect(llm.calls[0]!.user).toContain("Claim 1: Quoted, perhaps in translation: “The rents are far too high.”");
    expect(llm.calls[0]!.user).toContain("A: Die Mieten sind viel zu hoch.");
  });

  it("a translated quote inside a citing sentence is judged once, with its sentence", async () => {
    const llm = new FakeLLM([verdicts("unsupported")]);
    const r = await verifyAnswer({ judge: llm }, `She said "we will build homes in Hamburg" [00:00:20].`, { words });
    expect(r.unsupported).toEqual([`She said "we will build homes in Hamburg" [00:00:20].`]);
    expect([...llm.calls[0]!.user.matchAll(/^Claim \d+:/gm)]).toHaveLength(1);
  });

  it("each cited sentence is judged against the transcript ±45 s around its times", async () => {
    const long = Array.from({ length: 200 }, (_, i) => ({ text: `w${i}.`, startMs: i * 1000, endMs: i * 1000 + 500, confidence: 1, speaker: "A" }));
    const llm = new FakeLLM([verdicts("supported")]);
    await verifyAnswer({ judge: llm }, "Something [00:01:40].", { words: long });
    const user = llm.calls[0]!.user;
    expect(user).toContain("w55.");
    expect(user).toContain("w144.");
    expect(user).not.toContain("w54.");
    expect(user).not.toContain("w145.");
  });

  it("a failed judge call leaves the cited parts unchecked; quotes still count", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new FakeLLM([
      () => {
        throw new Error("timeout");
      },
    ]);
    const r = await verifyAnswer({ judge: failing }, "„Wir bauen mehr Wohnungen in Berlin“ [00:00:20].", { words });
    err.mockRestore();
    expect(r).toEqual({ unsupported: [], unchecked: ["„Wir bauen mehr Wohnungen in Berlin“ [00:00:20]."], checked: 1, judgeFailed: true });
  });

  it("an answer without a transcript checks nothing", async () => {
    expect(await verifyAnswer({ judge: new FakeLLM([]) }, "x [00:00:01].", null)).toEqual({ unsupported: [], unchecked: [], checked: 0, judgeFailed: false });
  });
});

describe("withCouldntConfirm", () => {
  it("adds one last line, merged with a line the model wrote itself", () => {
    expect(withCouldntConfirm("A [00:00:01].", [])).toBe("A [00:00:01].");
    expect(withCouldntConfirm("A [00:00:01].", ["“x y z w”", "B."])).toBe(`A [00:00:01].\n\n${COULDNT_CONFIRM}“x y z w”; B.`);
    const own = `A.\n\n${COULDNT_CONFIRM}the date\nMore.`;
    expect(withCouldntConfirm(own, ["“x y z w”"])).toBe(`A.\n\nMore.\n\n${COULDNT_CONFIRM}the date; “x y z w”`);
    expect(withCouldntConfirm(`A.\n${COULDNT_CONFIRM}the date`, ["the date"]).split(COULDNT_CONFIRM)).toHaveLength(2);
  });
});

describe("JUDGE_SYSTEM", () => {
  it("asks for 'unclear' (not checked) on claims that something isn't said: a ±45 s window can't show that", () => {
    expect(JUDGE_SYSTEM).toMatch(/not mentioned is always "unclear"/);
    expect(JUDGE_SYSTEM.indexOf('- "supported"')).toBeLessThan(JUDGE_SYSTEM.indexOf('- "unsupported"'));
    expect(JUDGE_SYSTEM.indexOf('- "unsupported"')).toBeLessThan(JUDGE_SYSTEM.indexOf('- "unclear"'));
  });
});
