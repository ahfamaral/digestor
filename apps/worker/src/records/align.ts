import { normaliseName, type ChamberId, type Turn } from "@digestor/core";
import type { NewAiAttribution } from "@digestor/core/server";
import type { RecordConnector, RecordSpeech } from "./connector.js";

/** Starting values; Task 16 tunes them. At or above CONFIRM a match is `confirmed`; between PROPOSE and CONFIRM, `proposed`. */
export const RECORD_CONFIRM = 0.6;
export const RECORD_PROPOSE = 0.35;

export const STOP: ReadonlySet<string> = new Set(
  ("the que para com uma uns umas por mais mas como dos das nos nas nao sim foi ser sao tem ter seu sua seus suas ele ela eles elas " +
    "isso esta este esse essa estao entre sobre quando muito muita ate tambem ainda ja so aos era meu minha nosso nossa nos " +
    "senhor senhora senhores senhoras presidente").split(" "),
);

/**
 * The record keeps a leading speaker prefix ("O SR. MAGNO MALTA (Bloco .../PL - ES) –") and parenthesised stage
 * directions ("(Manifestação da plateia.)"); the transcript has neither. Both are removed before tokenising.
 */
export function stripRecordMarkup(text: string): string {
  let t = text;
  let prev: string;
  do {
    prev = t;
    t = t.replace(/\([^()]*\)/g, " ");
  } while (t !== prev);
  return t.replace(/^\s*(?:O|A)\s+SRA?\.[^–\n]*?\s[–-]\s+/i, " ");
}

const HEADER = /^\s*(?:O|A)\s+SRA?\.\s+([^(–\n]+?)\s*(?:\(|[–-]\s)/;

/**
 * A speech's text as its own speaker said it. The record prints other people's turns inside a speech, each under its
 * own header ("O SR. PRESIDENTE (Davi Alcolumbre. ...) –" answering a senator's "pela ordem", a colleague's aparte);
 * they are dropped, keeping the parts headed by the speech's first speaker. Every kept part goes through
 * `stripRecordMarkup`.
 */
export function speechText(text: string): string {
  const parts = text.split(/\n(?=\s*(?:O|A)\s+SRA?\.\s)/);
  const owner = parts[0]?.match(HEADER)?.[1];
  if (!owner) return stripRecordMarkup(text);
  let current = owner;
  const kept: string[] = [];
  for (const part of parts) {
    current = part.match(HEADER)?.[1] ?? current;
    if (normaliseName(current) === normaliseName(owner)) kept.push(stripRecordMarkup(part));
  }
  return kept.join("\n");
}

function tokens(text: string, stop: ReadonlySet<string>): string[] {
  return normaliseName(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !stop.has(w));
}

function termCounts(toks: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/**
 * TF-IDF cosine between every turn (rows) and every speech (columns); idf is computed over turns and speeches together.
 * Note: cosine against the whole speech dilutes (~1/sqrt(k)) when one speech spans k turns. Measured on synthetic data:
 * whole speech 1.00, half 0.72-0.78, third 0.60-0.67, false pairs <= 0.30. Containment was tried and rejected (passages
 * shared between speeches gave false pairs up to 1.00). Tuning with real data is Task 16.
 */
export function similarityMatrix(turns: Turn[], speeches: RecordSpeech[], connector: Pick<RecordConnector, "speechText" | "stopWords">): number[][] {
  const docs = [
    ...turns.map((t) => termCounts(tokens(t.text, connector.stopWords))),
    ...speeches.map((s) => termCounts(tokens(connector.speechText(s), connector.stopWords))),
  ];
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const vecs = docs.map((d) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of d) {
      const w = (1 + Math.log(c)) * (Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1);
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) };
  });
  const tv = vecs.slice(0, turns.length);
  const sv = vecs.slice(turns.length);
  return tv.map((a) =>
    sv.map((b) => {
      if (a.norm === 0 || b.norm === 0) return 0;
      const [small, big] = a.v.size <= b.v.size ? [a.v, b.v] : [b.v, a.v];
      let dot = 0;
      for (const [t, w] of small) dot += w * (big.get(t) ?? 0);
      return dot / (a.norm * b.norm);
    }),
  );
}

/**
 * The order in which to hand speeches to `alignTurns`: a permutation of speech indexes. Speeches that share an `at`
 * stamp (the Câmara's 4-minute blocks; their real order is unknown) are reordered within each run of equal stamps by the
 * index of their best-matching turn (argmax of their similarity column; ties keep the current order). Speeches without
 * `at` (Senado) and runs of one are untouched.
 */
export function tieOrder(sim: number[][], speeches: RecordSpeech[]): number[] {
  const best = (j: number) => {
    let at = 0;
    let top = -1;
    sim.forEach((row, i) => {
      if ((row[j] ?? 0) > top) { top = row[j] ?? 0; at = i; }
    });
    return top > 0 ? at : -1;
  };
  const out: number[] = [];
  let j = 0;
  while (j < speeches.length) {
    let k = j + 1;
    const at = speeches[j]!.at;
    while (at !== undefined && k < speeches.length && speeches[k]!.at === at) k++;
    const run = Array.from({ length: k - j }, (_, x) => j + x);
    if (run.length > 1) {
      // only speeches matching some turn move, within the slots the matching ones occupy (stable: ties keep their order)
      const slots = run.map((x, pos) => (best(x) >= 0 ? pos : -1)).filter((pos) => pos >= 0);
      const sorted = slots.map((pos) => run[pos]!).sort((x, y) => best(x) - best(y));
      slots.forEach((pos, n) => (run[pos] = sorted[n]!));
    }
    out.push(...run);
    j = k;
  }
  return out;
}

/**
 * Monotonic alignment: each turn is skipped or assigned to a speech, assigned speeches never go backwards, a speech
 * can take many turns (with skipped turns between them) and a speech can have no turn. Only sim >= RECORD_PROPOSE
 * counts. g[i][j] = best total over turns 0..i-1 using speeches 0..j-1.
 */
export function alignTurns(sim: number[][]): { turn: number; speech: number; score: number }[] {
  const nT = sim.length;
  const nS = nT === 0 ? 0 : (sim[0]?.length ?? 0);
  const w = (i: number, j: number) => {
    const s = sim[i]![j]!;
    return s >= RECORD_PROPOSE ? s : 0;
  };
  const g: number[][] = Array.from({ length: nT + 1 }, () => new Array<number>(nS + 1).fill(0));
  for (let i = 1; i <= nT; i++) {
    for (let j = 1; j <= nS; j++) {
      g[i]![j] = Math.max(g[i]![j - 1]!, g[i - 1]![j]!, g[i - 1]![j]! + w(i - 1, j - 1));
    }
  }
  const out: { turn: number; speech: number; score: number }[] = [];
  let i = nT;
  let j = nS;
  while (i > 0 && j > 0) {
    const cur = g[i]![j]!;
    if (cur === g[i]![j - 1]) j--;
    else if (w(i - 1, j - 1) > 0 && cur === g[i - 1]![j]! + w(i - 1, j - 1)) {
      out.push({ turn: i - 1, speech: j - 1, score: sim[i - 1]![j - 1]! });
      i--;
    } else i--;
  }
  return out.reverse();
}

/** Ranged rows on each matched turn's bounds. A summary-only speech is never `confirmed`; a speech with no official id names no one. */
export function recordAttributions(
  turns: Turn[],
  speeches: RecordSpeech[],
  matches: ReturnType<typeof alignTurns>,
  personIdFor: (officialId: string) => string,
  ref: { url: string; fetchedAt: string; chamber?: ChamberId; date?: string },
  thresholds: { confirm: number; propose: number },
): NewAiAttribution[] {
  const rows: NewAiAttribution[] = [];
  for (const m of matches) {
    const turn = turns[m.turn];
    const speech = speeches[m.speech];
    if (!turn || !speech || speech.officialId === null || m.score < thresholds.propose) continue;
    const confirmed = m.score >= thresholds.confirm && speech.textSource === "full";
    rows.push({
      speakerId: turn.speakerId,
      startMs: turn.startMs,
      endMs: turn.endMs,
      personId: personIdFor(speech.officialId),
      status: confirmed ? "confirmed" : "proposed",
      confidence: m.score,
      evidence: {
        kind: "record", speechId: speech.id, score: m.score, url: ref.url, fetchedAt: ref.fetchedAt,
        ...(ref.chamber ? { chamber: ref.chamber } : {}), ...(ref.date ? { date: ref.date } : {}),
      },
    });
  }
  return rows;
}
