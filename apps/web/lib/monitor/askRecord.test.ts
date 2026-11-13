import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, replaceSpeechWindow, upsertMembers, type Db } from "@digestor/core/server";
import { askRecord, ASK_POOL, ownSentences, pickSentences, questionTopic, queryStems, type Passages } from "./askRecord";
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
  const textOf = (k: string) => rows.find((r) => r.speech_key === k)!.text;
  return { key, textOf, all: rows.map((r) => r.speech_key) };
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
    const { key, textOf } = await seed();
    const order = [key(1, 1), key(1, 2), key(1, 3), key(2, 1), key(1, 4), key(2, 2), key(3, 1), key(3, 2), key(4, 1)];
    const semantic = vi.fn(async () => ({ keys: [...order].reverse(), ok: true }));
    const passages = vi.fn<Passages>(async () => ({
      ok: true, passages: order.map((k, i) => ({ speechKey: k, sentences: [textOf(k)], score: 0.9 - i / 100 })),
    }));
    const r = await askRecord(db, "What did deputies say about the price of food?", { translate, semantic, passages });
    expect(r.ok).toBe(true);
    expect(r.passages.map((p) => p.speech.speechKey)).toEqual([key(1, 1), key(1, 2), key(2, 1), key(2, 2), key(3, 1), key(3, 2)]);
    expect(r.passages.map((p) => p.speech.member.externalId)).toEqual([1, 1, 2, 2, 3, 3]);
    // the worker searches and scores the question's topic (its framing left out), up to 3 passages per speech (the next
    // one when the best holds someone else's words), over the hybrid pool
    expect(semantic).toHaveBeenCalledWith("price of food");
    const [q, keys, perSpeech] = passages.mock.calls[0]!;
    expect(q).toBe("price of food");
    expect(perSpeech).toBe(3);
    expect(keys.length).toBeLessThanOrEqual(ASK_POOL);
    expect(new Set(keys)).toEqual(new Set(order));
  });

  it("keeps the record's sentences verbatim", async () => {
    const sentences = ["Senhor Presidente, venho falar hoje.", "O preço da comida subiu 7% em Manaus!", "Isso pesa no bolso do trabalhador.", "Obrigado."];
    const ids = await upsertMembers(db, [{ house: "camara" as const, externalId: 9, name: "Dep 9", party: "PT", uf: "AM", photoUrl: null }]);
    await replaceSpeechWindow(db, ids.get(9)!, "2026-02-01", "2026-11-11", [speech("2026-03-20T10:00", `O SR. DEP 9 (PT - AM. Sem revisão do orador.) - ${sentences.join(" ")}`)]);
    const { rows: [row] } = await db.execute<{ speech_key: string }>("select speech_key from parl_speeches");
    const k = row!.speech_key;
    const r = await askRecord(db, "preço da comida", {
      translate, semantic: async () => ({ keys: [k], ok: true }),
      passages: async () => ({ ok: true, passages: [{ speechKey: k, sentences, score: 0.8 }] }),
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

/** The Câmara's text of Dagoberto Nogueira's speech of 25 Mar 2026 (its first 2,043 characters): Kim Kataguiri's apartes
 * and the chair's turns are filed inside it. */
const DAGOBERTO =
  "O SR. DAGOBERTO NOGUEIRA (Bloco/PSDB - MS. Para proferir parecer. Sem revisão do orador.) - Sr. Presidente, Srs. Deputados, Sras. Deputadas, eu tenho um relatório. O meu parecer tem dezesseis folhas, porque é muito técnico. Eu queria pedir licença a V.Exa. para que eu possa resumir o meu voto, que é essa parte formal, depois eu discuto o mérito e fico à disposição de V.Exa. O SR. KIM KATAGUIRI (MISSÃO - SP. Para uma questão de ordem. Sem revisão do orador.) - Não, Presidente, questão de ordem. O Relator tem que ler o relatório na íntegra. Não existe isso de resumir. O SR. DAGOBERTO NOGUEIRA (Bloco/PSDB - MS) - Uai! Eu posso ler só o meu voto. Sempre é permitido aqui, Deputado Kim. O SR. KIM KATAGUIRI (MISSÃO - SP) - Não, não existe previsão regimental para isso. Se a gente vai jogar duro com o Regimento, a gente vai jogar duro com o Regimento. Qual é o dispositivo? O SR. DAGOBERTO NOGUEIRA (Bloco/PSDB - MS) - Eu vou ler o meu voto, eu não vou dispensar. O SR. PRESIDENTE (Charles Fernandes. Bloco/PSD - BA) - A palavra está com o Relator, Deputado Kim. Por favor, Deputado. O SR. KIM KATAGUIRI (MISSÃO - SP) - Questão de ordem, Presidente. Ele precisa ler o relatório. Ele falou que vai resumir. Ele não pode. O SR. PRESIDENTE (Charles Fernandes. Bloco/PSD - BA) - O relatório está publicado, Deputado Kim, e a palavra está com o Relator. Deputado Dagoberto Nogueira, por favor, continue. O SR. DAGOBERTO NOGUEIRA (Bloco/PSDB - MS) - O.k., Sr. Presidente, eu vou ler o meu voto e depois eu comento o mérito, como eu falei aqui no início. Sr. Presidente, o Projeto de Lei nº 6.359, de 2025, de autoria do Superior Tribunal de Justiça — STJ, dispõe sobre a criação de duas varas federais no Estado do Amazonas e seis varas federais no Estado de Mato Grosso do Sul. Trata-se de uma proposição de iniciativa legítima do Poder Judiciário, do STJ, em plena conformidade com a Constituição Federal, sem vícios de natureza formal ou material, que observa as normas fiscais e orçamentárias e fortalece a interiorização da Justiça Federal.";
/** The worker's two chunks of it, as sentences (`chunkSpeech` + `splitSentences`, the speaker header left out). */
const CHUNK_1 = [
  "Sr. Presidente, Srs. Deputados, Sras. Deputadas, eu tenho um relatório.",
  "O meu parecer tem dezesseis folhas, porque é muito técnico.",
  "Eu queria pedir licença a V.Exa. para que eu possa resumir o meu voto, que é essa parte formal, depois eu discuto o mérito e fico à disposição de V.Exa. O SR. KIM KATAGUIRI (MISSÃO - SP.",
  "Para uma questão de ordem.",
  "Sem revisão do orador.) - Não, Presidente, questão de ordem.",
  "O Relator tem que ler o relatório na íntegra.",
  "Não existe isso de resumir.",
  "O SR. DAGOBERTO NOGUEIRA (Bloco/PSDB - MS) - Uai!",
  "Eu posso ler só o meu voto.",
  "Sempre é permitido aqui, Deputado Kim.",
  "O SR. KIM KATAGUIRI (MISSÃO - SP) - Não, não existe previsão regimental para isso.",
  "Se a gente vai jogar duro com o Regimento, a gente vai jogar duro com o Regimento.",
  "Qual é o dispositivo?",
  "O SR. DAGOBERTO NOGUEIRA (Bloco/PSDB - MS) - Eu vou ler o meu voto, eu não vou dispensar.",
  "O SR. PRESIDENTE (Charles Fernandes.",
  "Bloco/PSD - BA) - A palavra está com o Relator, Deputado Kim.",
  "Por favor, Deputado.",
];
const CHUNK_2 = [
  "Por favor, Deputado.",
  "O SR. KIM KATAGUIRI (MISSÃO - SP) - Questão de ordem, Presidente.",
  "Ele precisa ler o relatório.",
  "Ele falou que vai resumir.",
  "Ele não pode.",
  "O SR. PRESIDENTE (Charles Fernandes.",
  "Bloco/PSD - BA) - O relatório está publicado, Deputado Kim, e a palavra está com o Relator.",
  "Deputado Dagoberto Nogueira, por favor, continue.",
  "O SR. DAGOBERTO NOGUEIRA (Bloco/PSDB - MS) - O.k., Sr. Presidente, eu vou ler o meu voto e depois eu comento o mérito, como eu falei aqui no início.",
  "Sr. Presidente, o Projeto de Lei nº 6.359, de 2025, de autoria do Superior Tribunal de Justiça — STJ, dispõe sobre a criação de duas varas federais no Estado do Amazonas e seis varas federais no Estado de Mato Grosso do Sul.",
  "Trata-se de uma proposição de iniciativa legítima do Poder Judiciário, do STJ, em plena conformidade com a Constituição Federal, sem vícios de natureza formal ou material, que observa as normas fiscais e orçamentárias e fortalece a interiorização da Justiça Federal.",
];
/** Words of other speakers in the excerpt (Kim Kataguiri's apartes and the chair): never quoted under Dagoberto's name. */
const OTHERS = [
  "Não, Presidente, questão de ordem.", "O Relator tem que ler o relatório na íntegra.", "Não existe isso de resumir.",
  "Não, não existe previsão regimental", "jogar duro com o Regimento", "Qual é o dispositivo?", "A palavra está com o Relator",
  "Por favor, Deputado.", "Questão de ordem, Presidente.", "Ele precisa ler o relatório.", "Ele falou que vai resumir.", "Ele não pode.",
  "O relatório está publicado", "por favor, continue.", "KIM KATAGUIRI", "PRESIDENTE (",
];

describe("ownSentences: only the speech owner's words are quotable", () => {
  it("marks other speakers' turns (apartes, the chair) and sentences that cross a turn as not quotable", () => {
    const own = ownSentences(DAGOBERTO, CHUNK_1, "Dagoberto Nogueira")!;
    expect(own).toEqual([
      CHUNK_1[0], CHUNK_1[1], null, null, null, null, null,
      "Uai!", CHUNK_1[8], CHUNK_1[9], null, null, null,
      "Eu vou ler o meu voto, eu não vou dispensar.", null, null, null,
    ]);
  });

  it("knows who speaks where a passage starts inside someone else's turn", () => {
    const own = ownSentences(DAGOBERTO, CHUNK_2, "Dagoberto Nogueira")!;
    expect(own).toEqual([
      null, null, null, null, null, null, null, null,
      "O.k., Sr. Presidente, eu vou ler o meu voto e depois eu comento o mérito, como eu falei aqui no início.", CHUNK_2[9], CHUNK_2[10],
    ]);
  });

  it("a speech opening with the chair's turn: the chair's words are not the owner's; a split owner header is left out", () => {
    const text = "O SR. PRESIDENTE (Fulano de Tal. PT - SP) - Tem a palavra o Deputado. O SR. BELTRANO (PL - SP. Sem revisão do orador.) - Peço a palavra. Falo da comida.";
    const sentences = ["Tem a palavra o Deputado.", "O SR. BELTRANO (PL - SP.", "Sem revisão do orador.) - Peço a palavra.", "Falo da comida."];
    expect(ownSentences(text, sentences, "Beltrano")).toEqual([null, null, "Peço a palavra.", "Falo da comida."]);
    // the chair is the owner only when the parenthesis names them
    expect(ownSentences(text, sentences.slice(0, 1), "Fulano de Tal")).toEqual(["Tem a palavra o Deputado."]);
  });

  it("a passage not found in the speech's text is not quotable at all (null)", () => {
    expect(ownSentences(DAGOBERTO, ["Uma frase que não está no texto."], "Dagoberto Nogueira")).toBeNull();
    expect(ownSentences("", ["Resumo da Câmara."], "Dagoberto Nogueira")).toBeNull();
  });

  it("a speech with no turn headers is all its owner's (a speech sent in writing)", () => {
    const text = "DISCURSO NA ÍNTEGRA ENCAMINHADO PELO SR. DEPUTADO FULANO (SEM REGISTRO TAQUIGRÁFICO). Senhor Presidente, venho à tribuna. Falo do preço da comida.";
    expect(ownSentences(text, ["Senhor Presidente, venho à tribuna.", "Falo do preço da comida."], "Fulano")).toEqual(["Senhor Presidente, venho à tribuna.", "Falo do preço da comida."]);
  });
});

describe("askRecord never quotes another speaker under the speech owner's name", () => {
  async function seedDagoberto() {
    const ids = await upsertMembers(db, [
      { house: "camara" as const, externalId: 141411, name: "Dagoberto Nogueira", party: "PSDB", uf: "MS", photoUrl: null },
      { house: "camara" as const, externalId: 5, name: "Sem Texto", party: "PT", uf: "SP", photoUrl: null },
    ]);
    await replaceSpeechWindow(db, ids.get(141411)!, "2026-02-01", "2026-11-11", [speech("2026-03-25T16:48", DAGOBERTO)]);
    await replaceSpeechWindow(db, ids.get(5)!, "2026-02-01", "2026-11-11", [
      { ...speech("2026-03-26T10:00", ""), summary: "Defesa da leitura integral do relatório pelo Relator." },
    ]);
    const { rows } = await db.execute<{ speech_key: string; text: string }>("select speech_key, text from parl_speeches");
    return { dag: rows.find((r) => r.text)!.speech_key, summaryOnly: rows.find((r) => !r.text)!.speech_key };
  }

  it("Kim Kataguiri's aparte about reading the report is not quoted as Dagoberto's; his own words are", async () => {
    const { dag } = await seedDagoberto();
    const r = await askRecord(db, "O que disseram sobre ler o relatório na íntegra?", {
      translate: async () => ({ terms: ["leitura do relatório"], translated: true, failed: false }),
      semantic: async () => ({ keys: [dag], ok: true }),
      passages: async () => ({ ok: true, passages: [{ speechKey: dag, sentences: CHUNK_2, score: 0.9 }, { speechKey: dag, sentences: CHUNK_1, score: 0.8 }] }),
    });
    expect(r.passages).toHaveLength(1);
    const quote = r.passages[0]!.sentences.join(" ");
    expect(quote.length).toBeGreaterThan(0);
    for (const words of OTHERS) expect(quote).not.toContain(words);
    for (const s of r.passages[0]!.sentences) expect(DAGOBERTO).toContain(s.replace(/^…|…$/gu, ""));
  });

  it("a passage that is only other speakers' turns falls back to the speech's next passage", async () => {
    const { dag } = await seedDagoberto();
    const chairAndKim = CHUNK_2.slice(0, 8);
    const r = await askRecord(db, "relatório", {
      translate: async () => ({ terms: ["relatório"], translated: true, failed: false }),
      semantic: async () => ({ keys: [dag], ok: true }),
      passages: async () => ({ ok: true, passages: [{ speechKey: dag, sentences: chairAndKim, score: 0.9 }, { speechKey: dag, sentences: CHUNK_1, score: 0.8 }] }),
    });
    expect(r.passages).toHaveLength(1);
    expect(r.passages[0]!.sentences).toContain("Sr. Presidente, Srs. Deputados, Sras. Deputadas, eu tenho um relatório.");
    for (const words of OTHERS) expect(r.passages[0]!.sentences.join(" ")).not.toContain(words);
  });

  it("a speech with no published text (its passages come from the Câmara's summary) is not quoted", async () => {
    const { summaryOnly } = await seedDagoberto();
    const r = await askRecord(db, "relatório", {
      translate: async () => ({ terms: ["relatório"], translated: true, failed: false }),
      semantic: async () => ({ keys: [summaryOnly], ok: true }),
      passages: async () => ({ ok: true, passages: [{ speechKey: summaryOnly, sentences: ["Defesa da leitura integral do relatório pelo Relator."], score: 0.9 }] }),
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

  it("deputies are framing only before the say/about word, and only when the question has one", () => {
    expect(questionTopic("What did deputies say about deputies' pay?")).toBe("deputies' pay");
    expect(questionTopic("O que os deputados disseram sobre os deputados federais?")).toBe("deputados federais");
    expect(questionTopic("Deputados federais e o aborto")).toBe("Deputados federais e o aborto");
    expect(questionTopic("Deputies and abortion")).toBe("Deputies and abortion");
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

  it("without the question's words (an English question, no translator), quotes the whole passage, cut at 1000", () => {
    expect(pickSentences(["Primeira.", "Segunda.", "Terceira.", "Quarta."], new Set())).toEqual(["Primeira.", "Segunda.", "Terceira.", "Quarta."]);
    expect(pickSentences(["Primeira.", "Segunda."], queryStems("price of food", []))).toEqual(["Primeira.", "Segunda."]);
    const many = Array.from({ length: 30 }, (_, i) => `Frase número ${i} sobre outra coisa qualquer.`);
    const whole = pickSentences(many, new Set());
    expect(whole.join(" ").length).toBeLessThanOrEqual(1001);
    expect(whole.at(-1)!.endsWith("…")).toBe(true);
    expect(many.join(" ").startsWith(whole.join(" ").slice(0, -1))).toBe(true);
  });

  it("marks a quote that starts or ends mid-sentence (a long sentence the worker cut) with an ellipsis, only at its edges", () => {
    expect(pickSentences(["e continuou falando do preço da comida.", "Fim."], stems)).toEqual(["…e continuou falando do preço da comida.", "Fim."]);
    expect(pickSentences(["Início.", "O preço da comida subiu e"], stems)).toEqual(["Início.", "O preço da comida subiu e…"]);
    // two pieces of one long sentence, shown together: no ellipsis between them
    expect(pickSentences(["O preço da comida subiu e", "continua subindo."], stems)).toEqual(["O preço da comida subiu e", "continua subindo."]);
    // quotes, digits and closing marks count as whole
    expect(pickSentences(["“O preço da comida”, disse ele.", "70% subiu!”"], stems)).toEqual(["“O preço da comida”, disse ele.", "70% subiu!”"]);
  });

  it("never edits a sentence; one longer than the cap is cut at a word with an ellipsis", () => {
    const long = `O preço da comida ${"subiu muito ".repeat(60)}no país.`;
    const [only, ...rest] = pickSentences([long, "Depois."], stems);
    expect(rest).toEqual([]);
    expect(only!.endsWith("…")).toBe(true);
    expect(long.startsWith(only!.slice(0, -1))).toBe(true);
    expect(only!.length).toBeLessThanOrEqual(451);
  });

  it("never quotes across a sentence that isn't the owner's (null), nor picks one", () => {
    const s = ["O preço da comida subiu.", null, "Fim do meu tempo.", "Obrigado."];
    expect(pickSentences(s, stems)).toEqual(["O preço da comida subiu."]);
    expect(pickSentences([null, "Outra coisa.", "Mais uma."], stems)).toEqual(["Outra coisa.", "Mais uma."]);
    expect(pickSentences(["Outra coisa.", null, "O preço da comida subiu.", "Fim."], stems)).toEqual(["O preço da comida subiu.", "Fim."]);
    expect(pickSentences([null, null], stems)).toEqual([]);
  });

  it("ignores question words like 'deputies' and 'say'", () => {
    expect(queryStems("O que os deputados disseram sobre a saúde?", [])).toEqual(new Set(["saude"]));
  });
});
