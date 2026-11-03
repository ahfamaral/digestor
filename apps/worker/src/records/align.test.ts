import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Turn } from "@digestor/core";
import { RECORD_CONFIRM, RECORD_PROPOSE, alignTurns, recordAttributions, similarityMatrix, speechText, stripRecordMarkup } from "./align.js";
import type { RecordSpeech } from "./senado.js";

const textos = JSON.parse(readFileSync(new URL("../../test/fixtures/senado-textos-2026-09-02.json", import.meta.url), "utf8")).texts as Record<string, string>;
const people: Record<string, string> = { "524179": "A", "524181": "B", "524182": "C", "524138": "D", "524139": "E", "524142": "F" };
const speech = (id: string, order: number, over: Partial<RecordSpeech> = {}): RecordSpeech => ({
  id, order, officialId: `off${id}`, name: people[id]!, party: null, state: null, text: textos[id]!, textSource: "full", ...over,
});
const speeches = ["524179", "524181", "524182", "524138", "524139"].map((id, i) => speech(id, i + 1));

/** What a transcript has: no prefix, no stage directions. Split into `parts` turns of roughly equal word counts. */
function spoken(id: string): string {
  return stripRecordMarkup(textos[id]!).replace(/\s+/g, " ").trim();
}
function split(text: string, parts: number): string[] {
  const w = text.split(" ");
  const n = Math.ceil(w.length / parts);
  return Array.from({ length: parts }, (_, k) => w.slice(k * n, (k + 1) * n).join(" ")).filter(Boolean);
}
let clock = 0;
const turn = (text: string, speakerId = "A"): Turn => ({ speakerId, startMs: clock, endMs: (clock += 10_000), text });
const turnsFor = (id: string, parts: number, speakerId = "A") => split(spoken(id), parts).map((t) => turn(t, speakerId));
const chair = (s = "B") => turn("Obrigado, tem a palavra o próximo orador inscrito.", s);

describe("stripRecordMarkup", () => {
  it("drops the leading speaker prefix (with a dash inside the parentheses) and stage directions", () => {
    const out = stripRecordMarkup(textos["524138"]!);
    expect(out).not.toMatch(/MAGNO MALTA/);
    expect(out).not.toMatch(/Pela ordem/);
    expect(out.trim().startsWith("Só para eu complementar")).toBe(true);
    expect(stripRecordMarkup("A SRA. DRA. EUDÓCIA (Bloco X/PSDB - AL. Para discursar.) – Boa noite (Manifestação da plateia.) a todos.")).not.toMatch(/EUDÓCIA|Manifesta/);
    expect(stripRecordMarkup("A SRA. FULANA – Boa noite.")).toMatch(/^\s*Boa noite\./);
  });
  it("makes a transcript turn match despite the prefix", () => {
    const withPrefix = [{ ...speeches[0]!, text: "O SR. FULANO DE TAL (Bloco Z/PL - ES) – " + spoken("524179") }];
    const t = [turn(spoken("524179"))];
    const bare = similarityMatrix(t, [speeches[0]!])[0]![0]!;
    const pre = similarityMatrix(t, withPrefix)[0]![0]!;
    expect(pre).toBeCloseTo(bare, 5);
  });
});

describe("alignTurns", () => {
  it("keeps speeches in order and lets a long speech span turns", () => {
    clock = 0;
    const turns = [...turnsFor("524179", 3), ...turnsFor("524181", 1), ...turnsFor("524182", 2), ...turnsFor("524138", 1), ...turnsFor("524139", 2)];
    const sim = similarityMatrix(turns, speeches);
    const m = alignTurns(sim);
    expect(m.map((x) => x.speech)).toEqual([0, 0, 0, 1, 2, 2, 3, 4, 4]);
    expect(m.map((x) => x.turn)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("skips turns that match nothing (apartes and chair lines)", () => {
    clock = 0;
    const turns = [...turnsFor("524179", 2), chair(), turn("Sim, com certeza, vamos adiante.", "C"), ...turnsFor("524181", 1), chair(), ...turnsFor("524182", 1)];
    const m = alignTurns(similarityMatrix(turns, speeches));
    expect(m.map((x) => [x.turn, x.speech])).toEqual([[0, 0], [1, 0], [4, 1], [6, 2]]);
  });

  it("handles a missing speech (one record speech has no turn)", () => {
    clock = 0;
    const turns = [...turnsFor("524179", 1), ...turnsFor("524182", 1), ...turnsFor("524139", 1)];
    const sim = similarityMatrix(turns, speeches);
    const m = alignTurns(sim);
    expect(m.map((x) => [x.turn, x.speech])).toEqual([[0, 0], [1, 2], [2, 4]]);
    const truth = [0, 2, 4];
    const falsePairs = sim.flatMap((row, i) => row.filter((_, j) => j !== truth[i]));
    expect(Math.max(...falsePairs)).toBeLessThan(RECORD_PROPOSE);
  });

  it("a swapped pair of record speeches costs at most the one swapped speech", () => {
    clock = 0;
    const turns = [...turnsFor("524179", 1), ...turnsFor("524181", 2), ...turnsFor("524182", 1), ...turnsFor("524138", 1)];
    const swapped = [speeches[0]!, speeches[2]!, speeches[1]!, speeches[3]!]; // 181 and 182 swapped in the record
    const m = alignTurns(similarityMatrix(turns, swapped));
    const by = new Map(m.map((x) => [x.turn, x.speech]));
    expect(by.get(0)).toBe(0);
    expect(by.get(4)).toBe(3);
    // one of the swapped speeches still aligns; the other is lost, never mismatched
    const mid = [1, 2, 3].filter((t) => by.has(t));
    expect(mid.length).toBeGreaterThanOrEqual(1);
    for (const t of mid) expect(by.get(t)).toBe(t === 3 ? 1 : 2);
    expect(m.length).toBeGreaterThanOrEqual(3);
    // monotonic: the two swapped speeches (indexes 1 and 2) cannot both align
    const used = new Set(m.map((x) => x.speech));
    expect(used.has(1) && used.has(2)).toBe(false);
  });
});

describe("other speakers inside a speech", () => {
  // The shape of the real record of 30/06/2026: the chair's reply is printed inside Hamilton Mourão's "pela ordem".
  const mourao = speech("524179", 1, {
    name: "Hamilton Mourão",
    text: [
      "O SR. HAMILTON MOURÃO (Bloco Parlamentar Aliança/REPUBLICANOS - RS. Pela ordem.) – Presidente, existe o PL 2.239, de 2022, de minha relatoria, que tem requerimento de urgência da Comissão de Constituição, Justiça e Cidadania, não tem emendas; eu solicito a V. Exa., extrapauta, esse PL...",
      "    O SR. PRESIDENTE (Davi Alcolumbre. Bloco Parlamentar Democracia/UNIÃO - AP) – Senador Hamilton Mourão, a Mesa me informa que V. Exa. já recolheu todas as assinaturas necessárias, do ponto de vista regimental, em relação a podermos incluir esta matéria como item extrapauta, já que foi também aprovado pela Comissão de Constituição e Justiça do Senado Federal, e a Mesa recolhe a solicitação de V. Exa., defere, e nós vamos incluir esta matéria como item extrapauta no final da deliberação.",
      "    O SR. HAMILTON MOURÃO (Bloco Parlamentar Aliança/REPUBLICANOS - RS) – Muito obrigado, Presidente.",
    ].join("\n\n"),
  });

  it("speechText keeps only the speech's own speaker, without headers", () => {
    const out = speechText(mourao.text);
    expect(out).toMatch(/existe o PL 2\.239/);
    expect(out).toMatch(/Muito obrigado, Presidente\./);
    expect(out).not.toMatch(/Mesa me informa|HAMILTON|PRESIDENTE \(|Bloco/);
    expect(speechText(textos["524182"]!)).toBe(stripRecordMarkup(textos["524182"]!)); // a chair speech keeps all its parts
  });

  it("the chair's reply printed inside a senator's speech doesn't match that speech", () => {
    clock = 0;
    const reply = turn("Senador Hamilton Mourão, a mesa me informa que Vossa Excelência já recolheu todas as assinaturas necessárias do ponto de vista regimental em relação a podermos incluir esta matéria como item extrapauta, já que foi também aprovado pela Comissão de Constituição e Justiça do Senado Federal, e a mesa recolhe a solicitação de Vossa Excelência, defere, e nós vamos incluir esta matéria como item extrapauta no final da deliberação.", "E");
    const own = turn("Presidente, existe o PL 2239 de 2022, de minha relatoria, Tem requerimento de urgência da Comissão de Constituição, Justiça e Cidadania. Não tem emendas. Eu solicito a Vossa Excelência extrapauta esse PL.", "E");
    const sim = similarityMatrix([reply, own], [mourao]);
    expect(sim[0]![0]!).toBeLessThan(RECORD_PROPOSE);
    expect(sim[1]![0]!).toBeGreaterThanOrEqual(RECORD_CONFIRM);
  });
});

describe("chair lines", () => {
  it("a line naming the next speaker scores below RECORD_PROPOSE and is left unmatched", () => {
    clock = 0;
    const turns = [turn("Com a palavra o Senador Orcival Pereira Xavier."), ...turnsFor("524181", 1)];
    const sim = similarityMatrix(turns, speeches);
    expect(sim[0]![1]!).toBeLessThan(RECORD_PROPOSE);
    expect(alignTurns(sim).map((x) => x.turn)).toEqual([1]);
  });
});

describe("recordAttributions", () => {
  const ref = { url: "https://legis.senado.leg.br/x", fetchedAt: "2026-11-03T10:00:00.000Z" };
  const T = [turn("a", "S1"), turn("b", "S1"), turn("c", "S1"), turn("d", "S2")];
  const personIdFor = (o: string) => `p-${o}`;

  it("confirms above RECORD_CONFIRM, proposes between the thresholds, drops below", () => {
    const rows = recordAttributions(T, speeches, [
      { turn: 0, speech: 0, score: RECORD_CONFIRM + 0.1 },
      { turn: 1, speech: 0, score: (RECORD_CONFIRM + RECORD_PROPOSE) / 2 },
      { turn: 2, speech: 1, score: RECORD_PROPOSE - 0.01 },
    ], personIdFor, ref);
    expect(rows.map((r) => r.status)).toEqual(["confirmed", "proposed"]);
    expect(rows[0]).toMatchObject({ personId: "p-off524179", confidence: RECORD_CONFIRM + 0.1, evidence: { kind: "record", speechId: "524179", url: ref.url, fetchedAt: ref.fetchedAt } });
  });

  it("never confirms a summary-only speech", () => {
    const sp = [speech("524179", 1, { textSource: "summary" })];
    const rows = recordAttributions(T, sp, [{ turn: 0, speech: 0, score: 0.9 }, { turn: 1, speech: 0, score: 0.2 }], personIdFor, ref);
    expect(rows.map((r) => r.status)).toEqual(["proposed"]);
  });

  it("writes ranged rows on the turn's bounds, even when two senators share a voice id", () => {
    const rows = recordAttributions(T, speeches, [{ turn: 2, speech: 0, score: 0.7 }, { turn: 3, speech: 1, score: 0.7 }], personIdFor, ref);
    expect(rows.map((r) => [r.speakerId, r.startMs, r.endMs, r.personId])).toEqual([
      ["S1", T[2]!.startMs, T[2]!.endMs, "p-off524179"],
      ["S2", T[3]!.startMs, T[3]!.endMs, "p-off524181"],
    ]);
    const shared = recordAttributions([turn("x", "S1"), turn("y", "S1")], speeches, [{ turn: 0, speech: 0, score: 0.7 }, { turn: 1, speech: 1, score: 0.7 }], personIdFor, ref);
    expect(shared.map((r) => r.personId)).toEqual(["p-off524179", "p-off524181"]);
    expect(shared[0]!.endMs).toBeLessThanOrEqual(shared[1]!.startMs!);
  });
});
