import { describe, expect, it } from "vitest";
import type { ContextCard, Fact, Word } from "@digestor/core";
import {
  assessSufficiency,
  buildContextPrompt,
  groundContext,
  normaliseProfile,
  understandContext,
  type ContextInput,
} from "./context.js";
import { FakeLLM, isParseError } from "../llm/structured.js";
import { OutputParserException } from "@langchain/core/output_parsers";
import { z } from "zod";

const none: Fact = { value: null, source: null, evidence: null };
const fact = (value: string, source: Fact["source"], evidence: string): Fact => ({ value, source, evidence });

function mk(text: string, speaker: string, startMs: number): Word[] {
  return text.split(" ").map((t, i) => ({
    text: t,
    startMs: startMs + i * 300,
    endMs: startMs + i * 300 + 250,
    speaker,
    confidence: 0.99,
  }));
}

const words: Word[] = [
  ...mk("Welcome to the show. Today we talk with a ministra Maria Silva.", "A", 0),
  ...mk("Thank you for having me.", "B", 12_000),
];

const input: ContextInput = {
  words,
  metadata: { title: "Weekly show", uploader: "Canal X" },
  hint: null,
  answers: [],
  language: { code: "pt", confidence: 0.978 },
  locked: {},
};

function card(over: Partial<ContextCard> = {}): ContextCard {
  return {
    language: none,
    profile: { value: "interview", confidence: 0.9, evidence: "Welcome to the show" },
    title: none,
    summary: "An interview.",
    setting: none,
    dateOrYear: fact("2026", "metadata", "Weekly show"),
    participants: [
      { speakerId: "A", name: none, role: fact("host", "video", "Welcome to the show"), affiliation: none },
      { speakerId: "B", name: none, role: fact("guest", "video", "Thank you for having me"), affiliation: none },
    ],
    sufficient: false,
    openQuestions: [],
    ...over,
  };
}

const withName = (name: Fact): ContextCard =>
  card({ participants: [{ speakerId: "A", name, role: none, affiliation: none }] });

describe("groundContext", () => {
  it("drops a name the transcript never says", () => {
    const c = groundContext(withName(fact("Maria Silva", "video", "a ministra Maria Silvia")), input);
    expect(c.participants[0]!.name).toEqual(none);
  });
  it("keeps a quoted fact (normalised)", () => {
    const c = groundContext(withName(fact("Maria Silva", "video", "A  MINISTRA, Maria Silva!")), input);
    expect(c.participants[0]!.name.value).toBe("Maria Silva");
  });
  it("nulls empty evidence and value without a source", () => {
    const c = groundContext(
      card({ title: fact("X", "video", "  "), setting: { value: "Studio", source: null, evidence: "Welcome" } }),
      input,
    );
    expect(c.title).toEqual(none);
    expect(c.setting).toEqual(none);
  });
  it("checks metadata and human sources", () => {
    const i = { ...input, hint: "recorded in Lisbon", answers: [{ question: "q", answer: "March 2026" }] };
    const c = groundContext(
      card({
        title: fact("Weekly show", "metadata", "weekly show"),
        setting: fact("Lisbon", "human", "recorded in Lisbon"),
        dateOrYear: fact("2026", "metadata", "not in metadata"),
      }),
      i,
    );
    expect(c.title.value).toBe("Weekly show");
    expect(c.setting.value).toBe("Lisbon");
    expect(c.dateOrYear).toEqual(none);
  });
  it("keeps a human-sourced value found in the answers even when the model misquotes them", () => {
    // Recorded: the model shortened the quote of the answer, so the evidence was no longer verbatim.
    const answer = 'Sexta-feira, 23 de outubro de 2026 (o candidato diz "É dia 23 de outubro"; a votação é no domingo).';
    const i = { ...input, answers: [{ question: "Em que data?", answer }] };
    const misquoted = fact("23 de outubro de 2026", "human", "Sexta-feira, 23 de outubro de 2026 (candidato diz: É dia 23 de outubro)");
    expect(groundContext(card({ dateOrYear: misquoted }), i).dateOrYear).toEqual(misquoted);
    const name = fact("César Tralli", "human", "o apresentador Tralli");
    const named = groundContext(withName(name), { ...i, answers: [{ question: "Quem é o A?", answer: "César Tralli" }] });
    expect(named.participants[0]!.name).toEqual(name);
  });
  it("still drops a human-sourced value the answers never contain", () => {
    const i = { ...input, answers: [{ question: "Em que data?", answer: "Foi numa sexta-feira" }] };
    expect(groundContext(card({ dateOrYear: fact("23 de outubro de 2026", "human", "23 de outubro") }), i).dateOrYear).toEqual(none);
  });
  it("never nulls language", () => {
    const lang = fact("pt", "video", "detected from audio (confidence 0.98)");
    expect(groundContext(card({ language: lang }), input).language).toEqual(lang);
  });
  it("human answers become human-sourced facts via locked", () => {
    const c = groundContext(card({ dateOrYear: none }), {
      ...input,
      locked: { dateOrYear: { value: "March 2026", source: "video", evidence: "March 2026" } },
    });
    expect(c.dateOrYear).toEqual({ value: "March 2026", source: "human", evidence: "March 2026" });
  });
  it("locked participants merge by speakerId", () => {
    const c = groundContext(card(), {
      ...input,
      locked: {
        participants: [{ speakerId: "B", name: fact("Ana", "human", "Ana"), role: none, affiliation: none }],
      },
    });
    expect(c.participants).toHaveLength(2);
    expect(c.participants.find((p) => p.speakerId === "B")!.name).toEqual(fact("Ana", "human", "Ana"));
    expect(c.participants.find((p) => p.speakerId === "A")!.role.value).toBe("host");
  });
});

describe("assessSufficiency", () => {
  it("is sufficient when everything is known and clears questions", () => {
    const c = assessSufficiency(
      card({ openQuestions: [{ id: "x", target: "other", speakerId: null, question: "?", why: "", sampleStartMs: null }] }),
      words,
    );
    expect(c.sufficient).toBe(true);
    expect(c.openQuestions).toEqual([]);
  });
  it("missing date makes context insufficient with a date question", () => {
    const c = assessSufficiency(card({ dateOrYear: none }), words);
    expect(c.sufficient).toBe(false);
    const q = c.openQuestions.find((x) => x.target === "date")!;
    expect(q.id).toBe("date");
    expect(q.question).toBe("When was this recorded or first aired?");
  });
  it("low event type confidence asks for the event type", () => {
    const c = assessSufficiency(card({ profile: { value: "other", confidence: 0.3, evidence: null } }), words);
    expect(c.openQuestions.find((x) => x.id === "profile")!.question).toBe("What kind of event is this?");
  });
  it("never more than 3 questions", () => {
    const c = assessSufficiency(
      card({
        dateOrYear: none,
        profile: { value: "other", confidence: 0.1, evidence: null },
        participants: [],
      }),
      words,
    );
    expect(c.sufficient).toBe(false);
    expect(c.openQuestions).toHaveLength(3);
  });
  it("participant question carries a sample start", () => {
    const c = assessSufficiency(
      card({ participants: [{ speakerId: "A", name: none, role: fact("host", "video", "Welcome"), affiliation: none }] }),
      words,
    );
    const q = c.openQuestions.find((x) => x.target === "participant")!;
    expect(q).toMatchObject({ id: "participant:B", speakerId: "B", question: "Who is Speaker B?", sampleStartMs: 12_000 });
  });
  it("LLM questions come first and are deduped by target+speaker", () => {
    const llmQ = { id: "zzz", target: "date" as const, speakerId: null, question: "Which year?", why: "w", sampleStartMs: null };
    const c = assessSufficiency(card({ dateOrYear: none, openQuestions: [llmQ, { ...llmQ, question: "again" }] }), words);
    const dates = c.openQuestions.filter((q) => q.target === "date");
    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatchObject({ id: "date", question: "Which year?" });
  });
  it("numbers other questions from 1", () => {
    const q = { id: "q", target: "other" as const, speakerId: null, question: "Where?", why: "w", sampleStartMs: null };
    const c = assessSufficiency(card({ dateOrYear: none, openQuestions: [q] }), words);
    expect(c.openQuestions.map((x) => x.id)).toEqual(["date", "other:1"]);
  });
});

describe("buildContextPrompt", () => {
  it("includes rules, event types, metadata, hint and transcript", () => {
    const { system, user } = buildContextPrompt({ ...input, hint: "a debate", answers: [{ question: "Who?", answer: "Ana" }] });
    expect(system).toContain("parliament");
    expect(system).toContain("otherwise null");
    expect(system).toContain("max 3");
    expect(user).toContain("Canal X");
    expect(user).toContain("a debate");
    expect(user).toContain("Ana");
    expect(user).toContain("[00:00:00] A: Welcome to the show.");
  });
});

describe("understandContext", () => {
  it("calls the reasoning model once, grounds, sets language and assesses", async () => {
    const llm = new FakeLLM([
      card({ language: none, title: fact("Invented", "video", "never said"), dateOrYear: none }),
    ]);
    const c = await understandContext(llm, input);
    expect(llm.calls).toHaveLength(1);
    expect(c.title).toEqual(none);
    expect(c.language).toEqual({ value: "pt", source: "video", evidence: "detected from audio (confidence 0.98)" });
    expect(c.sufficient).toBe(false);
    expect(c.openQuestions.some((q) => q.target === "date")).toBe(true);
  });
  it("an LLM card with 4 open questions is accepted and cut to 3", async () => {
    const q = (target: "date" | "profile" | "participant", speakerId: string | null, question: string) => ({
      id: question, target, speakerId, question, why: "w", sampleStartMs: null,
    });
    const llm = new FakeLLM([
      card({
        dateOrYear: none,
        profile: { value: "other", confidence: 0.1, evidence: null },
        participants: [],
        openQuestions: [q("date", null, "Which year?"), q("profile", null, "What event?"), q("participant", "A", "Who is A?"), q("participant", "B", "Who is B?")],
      }),
    ]);
    const c = await understandContext(llm, input);
    expect(c.openQuestions.map((x) => x.question)).toEqual(["Which year?", "What event?", "Who is A?"]);
  });
  it("unknown profile from the model becomes other and asks", async () => {
    const llm = new FakeLLM([
      { ...card(), profile: { value: "panel", confidence: 0.95, evidence: "Welcome to the show" } },
    ]);
    const c = await understandContext(llm, input);
    expect(c.profile).toMatchObject({ value: "other", confidence: 0 });
    expect(c.openQuestions.map((x) => x.id)).toContain("profile");
  });
  it("normaliseProfile clamps confidence to 0-1", () => {
    expect(normaliseProfile({ value: "trial", confidence: 7, evidence: null }).confidence).toBe(1);
    expect(normaliseProfile({ value: "trial", confidence: -2, evidence: null }).confidence).toBe(0);
  });
  it("FakeLLM rejects malformed responses and empty queue", async () => {
    const bad = new FakeLLM([{ nope: 1 }]);
    await expect(understandContext(bad, input)).rejects.toThrow();
    await expect(understandContext(new FakeLLM([]), input)).rejects.toThrow(/queue/i);
  });
});

describe("fix round 1", () => {
  const bananaInput: ContextInput = {
    ...input,
    words: [...mk("I ate a banana today.", "A", 0), ...mk("Thank you for having me.", "B", 12_000)],
  };
  it("matches evidence on whole words only", () => {
    const c = groundContext(withName(fact("Ana Costa", "video", "ana")), bananaInput);
    expect(c.participants[0]!.name).toEqual(none);
  });
  it("participant name must appear in its evidence", () => {
    const bad = groundContext(withName(fact("Maria Silva", "video", "a ministra")), input);
    expect(bad.participants[0]!.name).toEqual(none);
    const good = groundContext(withName(fact("Maria Silva", "video", "a ministra Maria Silva")), input);
    expect(good.participants[0]!.name.value).toBe("Maria Silva");
  });
  it("role keeps evidence-only check", () => {
    const c = groundContext(
      card({ participants: [{ speakerId: "A", name: none, role: fact("minister", "video", "a ministra"), affiliation: none }] }),
      input,
    );
    expect(c.participants[0]!.role.value).toBe("minister");
  });
  it("strips a timestamp/speaker prefix from evidence", () => {
    const c = groundContext(withName(fact("Maria Silva", "video", "[00:00:00] A: a ministra Maria Silva")), input);
    expect(c.participants[0]!.name.value).toBe("Maria Silva");
  });
  it("caps event type confidence when evidence is missing or unsupported", () => {
    const none_ = groundContext(card({ profile: { value: "interview", confidence: 0.9, evidence: null } }), input);
    expect(none_.profile.confidence).toBe(0.5);
    const bad = groundContext(card({ profile: { value: "interview", confidence: 0.9, evidence: "not said" } }), input);
    expect(bad.profile.confidence).toBe(0.5);
    expect(groundContext(card(), input).profile.confidence).toBe(0.9);
  });
  it("locked nulls stay null, not human-sourced", () => {
    const c = groundContext(card(), { ...input, locked: { title: none } });
    expect(c.title).toEqual(none);
  });
  it("required date question survives irrelevant LLM questions", () => {
    const o = (n: number) => ({ id: `${n}`, target: "other" as const, speakerId: null, question: `Q${n}`, why: "w", sampleStartMs: null });
    const llm = [
      { ...o(1), target: "participant" as const, speakerId: "A" },
      { ...o(2), target: "participant" as const, speakerId: "B" },
      { ...o(3), target: "profile" as const },
    ];
    const c = assessSufficiency(card({ dateOrYear: none, openQuestions: llm }), words);
    expect(c.openQuestions).toHaveLength(3);
    expect(c.openQuestions[0]!.id).toBe("date");
  });
  it("participant questions get real sample start; bogus speakers dropped", () => {
    const pq = (speakerId: string | null) => ({ id: "x", target: "participant" as const, speakerId, question: "Who?", why: "w", sampleStartMs: 5 });
    const c = assessSufficiency(card({ participants: [], openQuestions: [pq("B"), pq("Z"), pq(null)] }), words);
    expect(c.openQuestions.map((q) => q.id).sort()).toEqual(["participant:A", "participant:B"]);
    expect(c.openQuestions.find((q) => q.id === "participant:B")!.sampleStartMs).toBe(12_000);
  });
  it("prompt uses labels and the summary/prefix rules", () => {
    const { system } = buildContextPrompt(input);
    expect(system).toContain("summary must not state");
    expect(system).toContain("no [hh:mm:ss]");
    expect(system).not.toContain("Look for");
  });
  it("isParseError recognises parse/validation errors only", () => {
    const zerr = z.string().safeParse(1).error!;
    expect(isParseError(zerr)).toBe(true);
    expect(isParseError(new OutputParserException("bad"))).toBe(true);
    expect(isParseError(new Error("schema parse validation"))).toBe(false);
  });
  it("understandContext records the reasoning model", async () => {
    const llm = new FakeLLM([card()]);
    await understandContext(llm, input);
    expect(llm.calls[0]!.model).toBe("reasoning");
  });
});
