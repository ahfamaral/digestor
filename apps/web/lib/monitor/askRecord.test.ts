import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, replaceSpeechWindow, upsertMembers, type Db } from "@digestor/core/server";
import { askRecord, ASK_POOL, pickSentences, questionTopic, queryStems, type Passages } from "./askRecord";
import type { TranslateResult } from "./search";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(() => close());
beforeEach(async () => {
  await db.execute("TRUNCATE parl_votes, parl_roll_calls, parl_speeches, parl_members RESTART IDENTITY CASCADE");
});

const speech = (startsAt: string, text: string) => ({ startsAt, phase: null, kind: null, summary: "", text, keywords: "" });

/** Deputies 1–4 with 4, 2, 2 and 1 speeches about food prices; returns every key by "<deputy>.<n>". */
async function seed() {
  const ids = await upsertMembers(db, [1, 2, 3, 4].map((n) => ({ house: "camara" as const, externalId: n, name: `Dep ${n}`, party: "PT", uf: "SP", photoUrl: null })));
  const counts = { 1: 4, 2: 2, 3: 2, 4: 1 } as Record<number, number>;
  for (const [dep, n] of Object.entries(counts)) {
    await replaceSpeechWindow(db, ids.get(Number(dep))!, "2026-02-01", "2026-11-11",
      Array.from({ length: n }, (_, i) => speech(`2026-03-${String(10 + i).padStart(2, "0")}T1${dep}:00`, `Dep ${dep} fala ${i + 1}: o preço da comida subiu.`)));
  }
  const { rows } = await db.execute<{ speech_key: string; text: string }>("select speech_key, text from parl_speeches");
  const key = (dep: number, i: number) => rows.find((r) => r.text.startsWith(`Dep ${dep} fala ${i}:`))!.speech_key;
  return { key, all: rows.map((r) => r.speech_key) };
}

const translate = async (): Promise<TranslateResult> => ({ terms: ["preço da comida", "custo dos alimentos"], translated: true, failed: false });

describe("askRecord", () => {
  it("an empty question asks nothing", async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as Db;
    const semantic = vi.fn();
    expect(await askRecord(noDb, "   ", { semantic })).toEqual({ ok: true, passages: [] });
    expect(semantic).not.toHaveBeenCalled();
  });

  it("shows at most 2 passages per deputy and 6 in all, in the order of the passages' similarity", async () => {
    const { key } = await seed();
    const order = [key(1, 1), key(1, 2), key(1, 3), key(2, 1), key(1, 4), key(2, 2), key(3, 1), key(3, 2), key(4, 1)];
    const semantic = vi.fn(async () => ({ keys: [...order].reverse(), ok: true }));
    const passages = vi.fn<Passages>(async () => ({
      ok: true, passages: order.map((k, i) => ({ speechKey: k, sentences: [`Frase ${i}: o preço da comida.`], score: 0.9 - i / 100 })),
    }));
    const r = await askRecord(db, "What did deputies say about the price of food?", { translate, semantic, passages });
    expect(r.ok).toBe(true);
    expect(r.passages.map((p) => p.speech.speechKey)).toEqual([key(1, 1), key(1, 2), key(2, 1), key(2, 2), key(3, 1), key(3, 2)]);
    expect(r.passages.map((p) => p.speech.member.externalId)).toEqual([1, 1, 2, 2, 3, 3]);
    // the worker searches and scores the question's topic (its framing left out), one passage per speech, over the hybrid pool
    expect(semantic).toHaveBeenCalledWith("price of food");
    const [q, keys, perSpeech] = passages.mock.calls[0]!;
    expect(q).toBe("price of food");
    expect(perSpeech).toBe(1);
    expect(keys.length).toBeLessThanOrEqual(ASK_POOL);
    expect(new Set(keys)).toEqual(new Set(order));
  });

  it("keeps the record's sentences verbatim", async () => {
    const { key } = await seed();
    const sentences = ["Senhor Presidente, venho falar hoje.", "O preço da comida subiu 7% em Manaus!", "Isso pesa no bolso do trabalhador.", "Obrigado."];
    const r = await askRecord(db, "preço da comida", {
      translate, semantic: async () => ({ keys: [key(4, 1)], ok: true }),
      passages: async () => ({ ok: true, passages: [{ speechKey: key(4, 1), sentences, score: 0.8 }] }),
    });
    expect(r.passages).toHaveLength(1);
    const shown = r.passages[0]!.sentences;
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown.length).toBeLessThanOrEqual(3);
    for (const s of shown) expect(sentences).toContain(s);
    expect(shown).toContain("O preço da comida subiu 7% em Manaus!");
  });

  it("the dates narrow the speeches asked about", async () => {
    const { key, all } = await seed();
    const passages = vi.fn<Passages>(async () => ({ ok: true, passages: [] }));
    await askRecord(db, "preço da comida", { from: "2026-03-11", to: "2026-03-11", translate, semantic: async () => ({ keys: all, ok: true }), passages });
    expect(new Set(passages.mock.calls[0]![1])).toEqual(new Set([key(1, 2), key(2, 2), key(3, 2)]));
  });

  it("the worker down (search or passages) is ok: false, never a throw", async () => {
    const { all } = await seed();
    const passages = vi.fn<Passages>(async () => ({ ok: true, passages: [] }));
    expect(await askRecord(db, "preço da comida", { translate, semantic: async () => ({ keys: [], ok: false }), passages })).toEqual({ ok: false, passages: [] });
    expect(passages).not.toHaveBeenCalled();
    const down: Passages = async () => ({ ok: false, passages: [] });
    expect(await askRecord(db, "preço da comida", { translate, semantic: async () => ({ keys: all, ok: true }), passages: down })).toEqual({ ok: false, passages: [] });
  });

  it("nothing found is ok with no passages, and the worker isn't asked for passages", async () => {
    await seed();
    const passages = vi.fn<Passages>(async () => ({ ok: true, passages: [] }));
    const r = await askRecord(db, "astronautas em marte", { semantic: async () => ({ keys: [], ok: true }), passages });
    expect(r).toEqual({ ok: true, passages: [] });
    expect(passages).not.toHaveBeenCalled();
  });

  it("skips passages of speeches it didn't ask about, and passages with nothing left to quote", async () => {
    const { key } = await seed();
    const r = await askRecord(db, "preço da comida", {
      translate, semantic: async () => ({ keys: [key(4, 1)], ok: true }),
      passages: async () => ({
        ok: true,
        passages: [
          { speechKey: "nope", sentences: ["Outra coisa."], score: 0.9 },
          { speechKey: key(4, 1), sentences: ["DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO FULANO (SEM REGISTRO TAQUIGRÁFICO)."], score: 0.8 },
        ],
      }),
    });
    expect(r).toEqual({ ok: true, passages: [] });
  });
});

describe("questionTopic", () => {
  it("leaves out how the question is asked, so the passages are compared with what it is about", () => {
    expect(questionTopic("What did deputies say about the price of food?")).toBe("price of food");
    expect(questionTopic("O que os deputados disseram sobre a escala 6x1?")).toBe("escala 6x1");
    expect(questionTopic("Quais deputados falaram de reforma tributária?")).toBe("reforma tributária");
    expect(questionTopic("What have members of Congress said on femicide")).toBe("femicide");
  });

  it("keeps a topic as typed, and the whole question when nothing would be left", () => {
    expect(questionTopic("preço da comida")).toBe("preço da comida");
    expect(questionTopic("Is food getting more expensive?")).toBe("Is food getting more expensive");
    expect(questionTopic("What did they say?")).toBe("What did they say?");
    expect(questionTopic("o que disseram sobre o 8 de janeiro")).toBe("8 de janeiro");
  });
});

describe("pickSentences", () => {
  const stems = queryStems("What did deputies say about the price of food?", ["preço dos alimentos", "custo da comida"]);

  it("takes the sentence with the question's words and its neighbours, up to 3 and a length cap", () => {
    const s = ["É ela que cobra IPTU.", "Eduardo não foi ao debate.", "Não foi!", "Ele mentiu.", "Um Deputado disse que o alimento está mais barato."];
    expect(pickSentences(s, stems)).toEqual(["Não foi!", "Ele mentiu.", "Um Deputado disse que o alimento está mais barato."]);
  });

  it("drops the stenographer's header for a speech sent in writing", () => {
    const s = ["DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO ROBERTO DUARTE (SEM REGISTRO TAQUIGRÁFICO).", "Senhor Presidente, venho à tribuna.", "Falo do preço da comida na mesa."];
    expect(pickSentences(s, stems)).toEqual(["Senhor Presidente, venho à tribuna.", "Falo do preço da comida na mesa."]);
  });

  it("without the question's words, starts at the beginning", () => {
    expect(pickSentences(["Primeira.", "Segunda.", "Terceira.", "Quarta."], new Set())).toEqual(["Primeira.", "Segunda.", "Terceira."]);
  });

  it("never edits a sentence; one longer than the cap is cut at a word with an ellipsis", () => {
    const long = `O preço da comida ${"subiu muito ".repeat(60)}no país.`;
    const [only, ...rest] = pickSentences([long, "Depois."], stems);
    expect(rest).toEqual([]);
    expect(only!.endsWith("…")).toBe(true);
    expect(long.startsWith(only!.slice(0, -1))).toBe(true);
    expect(only!.length).toBeLessThanOrEqual(451);
  });

  it("ignores question words like 'deputies' and 'say'", () => {
    expect(queryStems("O que os deputados disseram sobre a saúde?", [])).toEqual(new Set(["saude"]));
  });
});
