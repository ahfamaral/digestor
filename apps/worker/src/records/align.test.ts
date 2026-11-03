import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Turn } from "@digestor/core";
import { RECORD_CONFIRM, RECORD_PROPOSE, alignTurns, recordAttributions, similarityMatrix, stripRecordMarkup } from "./align.js";
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
    console.log("true-pair scores", m.map((x) => x.score.toFixed(2)).join(" "));
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
    console.log("false-pair max", Math.max(...falsePairs).toFixed(2));
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
