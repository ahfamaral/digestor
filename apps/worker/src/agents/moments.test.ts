import { describe, expect, it } from "vitest";
import type { Boundary, ContextCard, Fact, Topic, Transcript, Word } from "@digestor/core";
import { MAX_GAP_CALLS, PASS_CONCURRENCY, buildPunchlinesPrompt, findMoments, gapsBetween, normalizeMoments, punchlineCap } from "./moments.js";
import { FakeLLM, type StructuredLLM } from "../llm/structured.js";
import { MissingApiKeyError } from "../errors.js";

const MIN = 60_000;
const none: Fact = { value: null, source: null, evidence: null };
const DURATION = 40 * MIN;
const boundaries: Boundary[] = Array.from({ length: DURATION / 1000 + 1 }, (_, i) => ({
  afterWordEndMs: i * 1000,
  beforeWordStartMs: i * 1000 + 100,
}));
const ts = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const lm = (o: Partial<Record<string, unknown>> & { a: number; b: number }) => ({
  title: "Moment",
  why: "Because.",
  highlightTypes: ["heated"],
  relevance: 70,
  granularity: "exchange",
  start: ts(o.a),
  end: ts(o.b),
  evidence: ["word"],
  ...o,
  a: undefined,
  b: undefined,
});
const clean = (o: ReturnType<typeof lm>) => {
  const { a: _a, b: _b, ...rest } = o as Record<string, unknown>;
  return rest;
};
const m = (o: Parameters<typeof lm>[0]) => clean(lm(o));

function card(profile: ContextCard["profile"]["value"] = "parliament"): ContextCard {
  return {
    language: none,
    profile: { value: profile, confidence: 0.9, evidence: "x" },
    title: none,
    summary: "A session.",
    setting: none,
    dateOrYear: none,
    participants: [],
    sufficient: true,
    openQuestions: [],
  };
}
/** One sentence-ending word per second; speaker A until `switchAtS`, then B. */
function makeTranscript(switchAtS = 1500, minutes = 40): Transcript {
  const durationMs = minutes * MIN;
  const words: Word[] = Array.from({ length: durationMs / 1000 }, (_, i) => ({
    text: "word.",
    startMs: i * 1000,
    endMs: i * 1000 + 500,
    speaker: i < switchAtS ? "A" : "B",
    confidence: 0.99,
  }));
  return { words, durationMs, language: "en", languageConfidence: 0.99 };
}
const topic = (id: string, idx: number, startMs: number, endMs: number): Topic => ({
  id,
  analysisId: "an",
  idx,
  startMs,
  endMs,
  title: `Topic ${id}`,
  summary: "",
});
/** `n` topics of 8 minutes; exchange i of topic k is `E<k>-<i>`, 62 s long (snapping can shave a second), 8 per topic. */
const bigTopics = (n: number) => Array.from({ length: n }, (_, k) => topic(`t${k}`, k, k * 8 * MIN, (k + 1) * 8 * MIN));
const exchangesFor = (k: number, rel: (i: number) => number) =>
  Array.from({ length: 8 }, (_, i) =>
    m({ a: k * 8 * MIN + i * 57_000, b: k * 8 * MIN + i * 57_000 + 62_000, title: `E${k}-${i}`, relevance: rel(i) }),
  );
const twoTopics = [topic("t1", 0, 0, 20 * MIN), topic("t2", 1, 20 * MIN, DURATION)];
const oneTopic = [topic("t1", 0, 0, DURATION)];

describe("normalizeMoments", () => {
  it("drops and clamps per item", () => {
    const raw = [
      m({ a: 5 * MIN, b: 10 * MIN, title: "good" }),
      m({ a: 12 * MIN, b: 16 * MIN, title: "hot", relevance: 140 }),
      m({ a: 17 * MIN, b: 20 * MIN, title: "spicy+heated", highlightTypes: ["spicy", "heated"] }),
      m({ a: 21 * MIN, b: 24 * MIN, title: "spicy only", highlightTypes: ["spicy"] }),
      m({ a: 26 * MIN, b: 25 * MIN, title: "reversed" }),
      m({ a: 35 * MIN, b: 38 * MIN, title: "outside" }),
      m({ a: 27 * MIN, b: 27 * MIN + 30_000, title: "too short" }),
      m({ a: 28 * MIN, b: 29 * MIN, title: "chapter", granularity: "chapter" }),
    ] as never;
    const out = normalizeMoments(raw, {
      durationMs: DURATION,
      boundaries,
      within: { startMs: 0, endMs: 30 * MIN },
      allowed: ["exchange", "passage"],
      types: ["heated", "key_point"],
    });
    expect(out.map((x) => x.title)).toEqual(["hot", "good", "spicy+heated", "spicy only"]);
    expect(out[0]!.relevance).toBe(100);
    expect(out[2]!.highlightTypes).toEqual(["heated"]);
    expect(out[3]!.highlightTypes).toEqual([]);
    expect(out[1]!.startMs).toBe(5 * MIN);
  });

  it("rounds relevance and filters types to the allowed ones", () => {
    const out = normalizeMoments([m({ a: 0, b: 2 * MIN, relevance: 55.6, highlightTypes: ["laughter", "heated"] })] as never, {
      durationMs: DURATION,
      boundaries,
      within: { startMs: 0, endMs: DURATION },
      allowed: ["exchange"],
      types: ["heated"],
    });
    expect(out[0]).toMatchObject({ relevance: 56, highlightTypes: ["heated"] });
  });
});

describe("findMoments", () => {
  it("survives one failed topic call", async () => {
    const fake = new FakeLLM({
      byName: {
        moments: [{ moments: [m({ a: 21 * MIN, b: 26 * MIN, title: "second topic" })] }],
        punchlines: [{ punchlines: [] }],
      },
    });
    let first = true;
    const llm: StructuredLLM = {
      generate: (a) => {
        if (a.name === "moments" && first) {
          first = false;
          return Promise.reject(new Error("boom"));
        }
        return fake.generate(a);
      },
    };
    const out = await findMoments(llm, { card: card(), transcript: makeTranscript(), topics: twoTopics });
    const ai = out.filter((x) => x.origin === "ai");
    expect(ai.map((x) => x.title)).toEqual(["second topic"]);
    expect(ai[0]).toMatchObject({ topicId: "t2", speakers: ["A", "B"], origin: "ai" });
    expect(ai[0]!.highlights).toEqual([{ type: "heated", method: "ai", value: null }]);
  });

  it("rethrows a MissingApiKeyError instead of degrading", async () => {
    const llm: StructuredLLM = {
      generate: () => Promise.reject(new MissingApiKeyError("ANTHROPIC_API_KEY")),
    };
    await expect(findMoments(llm, { card: card(), transcript: makeTranscript(), topics: oneTopic })).rejects.toBeInstanceOf(
      MissingApiKeyError,
    );
  });

  it("punchlines lie inside their exchange and link to it", async () => {
    const fake = new FakeLLM({
      byName: {
        moments: [
          {
            moments: [
              m({ a: 2 * MIN, b: 8 * MIN, title: "exchange" }),
              m({ a: 3 * MIN, b: 3 * MIN + 60_000, title: "passage", granularity: "passage" }),
            ],
          },
        ],
        punchlines: [
          {
            punchlines: [
              m({ a: 4 * MIN, b: 4 * MIN + 20_000, title: "inside", granularity: "punchline" }),
              m({ a: 9 * MIN, b: 9 * MIN + 20_000, title: "outside", granularity: "punchline" }),
            ],
          },
        ],
      },
    });
    const out = await findMoments(fake, { card: card("interview"), transcript: makeTranscript(), topics: oneTopic });
    const ex = out.findIndex((x) => x.title === "exchange");
    const pl = out.find((x) => x.title === "inside")!;
    expect(out.map((x) => x.title).sort()).toEqual(["exchange", "inside", "passage"]);
    expect(pl.granularity).toBe("punchline");
    expect(pl.insideIdx).toBe(ex);
    expect(pl.startMs).toBeGreaterThanOrEqual(out[ex]!.startMs);
    expect(pl.endMs).toBeLessThanOrEqual(out[ex]!.endMs);
    expect(out.find((x) => x.title === "passage")!.insideIdx).toBe(ex);
    expect(out[ex]!.insideIdx).toBeUndefined();
    expect(fake.calls.filter((c) => c.name === "punchlines")).toHaveLength(1);
  });

  it("caps: 8 exchanges per topic by relevance, 4 punchlines per exchange", async () => {
    const exchanges = Array.from({ length: 15 }, (_, i) =>
      m({ a: i * 150_000, b: i * 150_000 + 100_000, title: `E${i}`, relevance: 10 + i * 5 }),
    );
    const best = 14 * 150_000; // E14 has the highest relevance
    const punchlines = Array.from({ length: 6 }, (_, i) =>
      m({ a: best + 10_000 + i * 15_000, b: best + 20_000 + i * 15_000, title: `P${i}`, granularity: "punchline", relevance: 50 + i }),
    );
    const fake = new FakeLLM({
      byName: {
        moments: [{ moments: exchanges }],
        punchlines: [{ punchlines }, ...Array.from({ length: 7 }, () => ({ punchlines: [] }))],
      },
    });
    const out = await findMoments(fake, { card: card("interview"), transcript: makeTranscript(), topics: oneTopic });
    const ex = out.filter((x) => x.granularity === "exchange");
    expect(ex.map((x) => x.title).sort()).toEqual(["E10", "E11", "E12", "E13", "E14", "E7", "E8", "E9"].sort());
    const pls = out.filter((x) => x.granularity === "punchline");
    expect(pls).toHaveLength(4);
    expect(pls.map((x) => x.title).sort()).toEqual(["P2", "P3", "P4", "P5"]);
    const parent = out.findIndex((x) => x.title === "E14");
    for (const p of pls) expect(p.insideIdx).toBe(parent);
    expect(fake.calls.filter((c) => c.name === "punchlines")).toHaveLength(8);
  });

  it("a long exchange keeps more punchlines: one per 45 s, between 4 and 8", async () => {
    expect([60_000, 180_000, 225_000, 360_000, 900_000].map((ms) => punchlineCap({ startMs: 0, endMs: ms }))).toEqual([4, 4, 5, 8, 8]);
    const exchange = m({ a: 2 * MIN, b: 8 * MIN, title: "Long round" }); // 6 minutes
    const punchlines = Array.from({ length: 10 }, (_, i) =>
      m({ a: 2 * MIN + 10_000 + i * 30_000, b: 2 * MIN + 20_000 + i * 30_000, title: `P${i}`, granularity: "punchline", relevance: 50 + i }),
    );
    const fake = new FakeLLM({ byName: { moments: [{ moments: [exchange] }], punchlines: [{ punchlines }] } });
    const out = await findMoments(fake, { card: card("interview"), transcript: makeTranscript(), topics: oneTopic });
    const pls = out.filter((x) => x.granularity === "punchline");
    expect(pls.map((x) => x.title).sort()).toEqual(["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
    expect(fake.calls.find((c) => c.name === "punchlines")!.system).toContain("at most 8.");
  });

  it("the punchline prompt states the exchange's own cap", () => {
    const words = makeTranscript().words;
    const short = buildPunchlinesPrompt({ card: card(), exchange: { startMs: 0, endMs: 2 * MIN, title: "Short" }, words });
    expect(short.system).toContain("at most 4.");
  });

  it("gapsBetween: stretches of each topic no exchange covers, at least 30 s, long ones split", () => {
    const t = (startMs: number, endMs: number) => ({ id: "t", startMs, endMs });
    const ex = (a: number, b: number) => ({ startMs: a, endMs: b });
    const gaps = gapsBetween([t(0, 20 * MIN)], [ex(2 * MIN, 5 * MIN), ex(5 * MIN + 10_000, 8 * MIN), ex(7 * MIN, 8 * MIN + 20_000), ex(8 * MIN + 50_000, 20 * MIN), ex(30 * MIN, 32 * MIN)]);
    // 0–2:00 kept; 5:00–5:10 and 8:00–8:20 (overlapped) are too short; 8:20–8:50 is exactly 30 s.
    expect(gaps.map((g) => [g.startMs, g.endMs])).toEqual([[0, 2 * MIN], [8 * MIN + 20_000, 8 * MIN + 50_000]]);
    // 13 minutes with no exchange: three equal windows of 4:20.
    expect(gapsBetween([t(0, 13 * MIN)], []).map((g) => g.endMs - g.startMs)).toEqual([260_000, 260_000, 260_000]);
  });

  it("finds punchlines between exchanges and nests them under the passage they lie in", async () => {
    const calls: { name: string; user: string }[] = [];
    const llm: StructuredLLM = {
      generate: async (a) => {
        calls.push({ name: a.name, user: a.user });
        if (a.name === "moments") {
          return a.schema.parse({
            moments: [m({ a: 2 * MIN, b: 8 * MIN, title: "Round" }), m({ a: 10 * MIN, b: 11 * MIN, title: "Aside", granularity: "passage" })],
          });
        }
        // Offered to every stretch: only the one it lies in may keep it.
        const between = m({ a: 10 * MIN + 20_000, b: 10 * MIN + 35_000, title: "Between", granularity: "punchline" });
        return a.schema.parse({ punchlines: a.name === "gap_punchlines" ? [between] : [] });
      },
    };
    const out = await findMoments(llm, { card: card("interview"), transcript: makeTranscript(), topics: oneTopic });
    // 0:00–2:00, and 8:00–40:00 split into six windows of 5:20.
    const gapCalls = calls.filter((c) => c.name === "gap_punchlines");
    expect(gapCalls).toHaveLength(7);
    expect(gapCalls[0]!.user).toContain('Stretch of the topic "Topic t1" between exchanges');
    expect(out.filter((x) => x.title === "Between")).toHaveLength(1);
    const pl = out.find((x) => x.title === "Between")!;
    expect(pl).toMatchObject({ granularity: "punchline", topicId: "t1" });
    expect(pl.insideIdx).toBe(out.findIndex((x) => x.title === "Aside"));
  });

  it("punchline calls between exchanges are capped, longest stretch first", async () => {
    const topics = [
      ...Array.from({ length: MAX_GAP_CALLS + 5 }, (_, k) => topic(`s${k}`, k, k * 80_000, (k + 1) * 80_000)),
      topic("long", MAX_GAP_CALLS + 5, (MAX_GAP_CALLS + 5) * 80_000, DURATION),
    ];
    const fake = new FakeLLM({ byName: { moments: topics.map(() => ({ moments: [] })), gap_punchlines: Array.from({ length: MAX_GAP_CALLS }, () => ({ punchlines: [] })) } });
    await findMoments(fake, { card: card("interview"), transcript: makeTranscript(), topics });
    const gapCalls = fake.calls.filter((c) => c.name === "gap_punchlines");
    expect(gapCalls).toHaveLength(MAX_GAP_CALLS);
    expect(gapCalls.filter((c) => c.user.includes('topic "Topic long"'))).toHaveLength(Math.ceil((DURATION - (MAX_GAP_CALLS + 5) * 80_000) / (6 * MIN)));
  });

  it("punchline calls are limited to the 40 most relevant exchanges", async () => {
    // 6 topics x 8 exchanges = 48; relevance 1..48 is unique, so the top 40 are 9..48.
    const topics = bigTopics(6);
    const llm = new FakeLLM({
      byName: {
        moments: topics.map((_, k) => ({ moments: exchangesFor(k, (i) => k * 8 + i + 1) })),
        punchlines: Array.from({ length: 48 }, () => ({ punchlines: [] })),
      },
    });
    await findMoments(llm, { card: card("interview"), transcript: makeTranscript(1500, 48), topics });
    const calls = llm.calls.filter((c) => c.name === "punchlines");
    expect(calls).toHaveLength(40);
    const picked = calls.map((c) => {
      const [k, i] = /Exchange: "E(\d+)-(\d+)"/.exec(c.user)!.slice(1).map(Number) as [number, number];
      return k * 8 + i + 1;
    });
    expect(picked.sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 9));
  });

  it("MissingApiKeyError stops further punchline calls", async () => {
    const topics = bigTopics(6);
    let punchCalls = 0;
    const llm: StructuredLLM = {
      generate: async (a) => {
        if (a.name === "moments") {
          const k = Number(/Topic t(\d+)/.exec(a.user)![1]);
          return a.schema.parse({ moments: exchangesFor(k, () => 50) });
        }
        punchCalls++;
        throw new MissingApiKeyError("ANTHROPIC_API_KEY");
      },
    };
    await expect(
      findMoments(llm, { card: card("interview"), transcript: makeTranscript(1500, 48), topics }),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(punchCalls).toBeLessThanOrEqual(PASS_CONCURRENCY); // only the calls already in flight
  });

  it("drops the punchlines of an exchange the moment cap cut", async () => {
    // 20 topics: 8 exchanges (relevance 40) + 12 passages (relevance 90) each. Punchlines (55) outrank exchanges,
    // but the 250 cap keeps the 240 passages plus only 10 of the 40 punchlines, so every exchange is cut and no punchline may remain.
    const topics = bigTopics(20);
    const llm: StructuredLLM = {
      generate: async (a) => {
        if (a.name === "moments") {
          const k = Number(/Topic t(\d+)/.exec(a.user)![1]);
          const passages = Array.from({ length: 12 }, (_, i) =>
            m({ a: k * 8 * MIN + i * 35_000, b: k * 8 * MIN + i * 35_000 + 30_000, title: `P${k}-${i}`, granularity: "passage", relevance: 90 }),
          );
          return a.schema.parse({ moments: [...exchangesFor(k, () => 40), ...passages] });
        }
        const [k, i] = /Exchange: "E(\d+)-(\d+)"/.exec(a.user)!.slice(1).map(Number) as [number, number];
        const s0 = k * 8 * MIN + i * 57_000 + 10_000;
        return a.schema.parse({ punchlines: [m({ a: s0, b: s0 + 15_000, title: `L${k}-${i}`, granularity: "punchline", relevance: 55 })] });
      },
    };
    const out = await findMoments(llm, { card: card("interview"), transcript: makeTranscript(1500, 160), topics });
    // 240 passages + 10 punchlines made the cut, but their exchanges did not, so the punchlines went too.
    expect(out).toHaveLength(240);
    expect(out.every((n) => n.granularity === "passage")).toBe(true);
  });

  it("a non-numeric relevance drops only that item; numeric strings are coerced", () => {
    const out = normalizeMoments(
      [
        m({ a: 0, b: 2 * MIN, title: "str", relevance: "72" }),
        m({ a: 3 * MIN, b: 5 * MIN, title: "bad", relevance: "high" }),
        m({ a: 6 * MIN, b: 8 * MIN, title: "ok", relevance: 10 }),
      ] as never,
      { durationMs: DURATION, boundaries, within: { startMs: 0, endMs: DURATION }, allowed: ["exchange"], types: ["heated"] },
    );
    expect(out.map((x) => [x.title, x.relevance])).toEqual([["str", 72], ["ok", 10]]);
  });

  it("adds the counted longest speech for parliament only", async () => {
    const empty = () => new FakeLLM({ byName: { moments: [{ moments: [] }], punchlines: [] } });
    const parl = await findMoments(empty(), { card: card("parliament"), transcript: makeTranscript(), topics: oneTopic });
    expect(parl).toHaveLength(1);
    expect(parl[0]).toMatchObject({ origin: "counted", granularity: "exchange", speakers: ["A"], topicId: "t1" });
    expect(parl[0]!.highlights).toEqual([{ type: "longest_speech", method: "counted", value: expect.any(Number) }]);
    expect(parl[0]!.endMs - parl[0]!.startMs).toBeGreaterThan(1_200_000); // no upper cap
    const interview = await findMoments(empty(), { card: card("interview"), transcript: makeTranscript(), topics: oneTopic });
    expect(interview).toHaveLength(0);
  });
});
