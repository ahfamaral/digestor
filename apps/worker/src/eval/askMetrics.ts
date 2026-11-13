import { parseTimestamp } from "@digestor/core";
import { NOT_IN_DATA } from "../agents/ask.js";

/** Hand-labelled questions for one video's Ask evaluation (task B1). */
export type AskGoldenQuestion = {
  id: string;
  question: string;
  answerable: boolean;
  /** Transcript spans that answer it (empty when unanswerable). */
  expect: { startMs: number; endMs: number }[];
  /** A short verbatim phrase the answer should be able to quote, when there is one. */
  quote?: string;
};
export type AskGolden = { sessionId: string; labelledBy: string; questions: AskGoldenQuestion[] };

type Span = { startMs: number; endMs: number };

const overlaps = (a: Span, b: Span) => a.startMs < b.endMs && b.startMs < a.endMs;

/**
 * Recall@k and mean reciprocal rank over the answerable questions. A hit counts when it overlaps an expected span;
 * the rank is that of the first hit within the first k. Unanswerable questions are skipped.
 */
export function retrievalScores(qs: AskGoldenQuestion[], hits: Map<string, Span[]>, k: number): { recallAtK: number; mrr: number; n: number } {
  const answerable = qs.filter((q) => q.answerable);
  if (answerable.length === 0) return { recallAtK: 0, mrr: 0, n: 0 };
  let found = 0;
  let rr = 0;
  for (const q of answerable) {
    const rank = (hits.get(q.id) ?? []).slice(0, k).findIndex((h) => q.expect.some((e) => overlaps(h, e)));
    if (rank >= 0) {
      found += 1;
      rr += 1 / (rank + 1);
    }
  }
  return { recallAtK: found / answerable.length, mrr: rr / answerable.length, n: answerable.length };
}

const CITATION_SLACK_MS = 30_000;
// The model sometimes translates the first word of NOT_IN_DATA ("Das isn't in this video's data."), so the tail is matched.
const REFUSALS = [NOT_IN_DATA, NOT_IN_DATA.replace(/^That /, ""), "I couldn't confirm"];

/**
 * citationHit: share of answerable answers with a cited time inside an expected span ±30 s.
 * quoteExact: share of answers that quote text whose quotes all appear verbatim in the transcript.
 * refusalCorrect: share of unanswerable questions answered with NOT_IN_DATA or "I couldn't confirm".
 * Each is 0 when its denominator is empty. `n` is the number of questions.
 */
export function answerScores(
  rows: { q: AskGoldenQuestion; answer: string; citedMs: number[]; quotesFound: boolean[] }[],
): { citationHit: number; quoteExact: number; refusalCorrect: number; n: number } {
  const share = (num: number, den: number) => (den === 0 ? 0 : num / den);
  const answerable = rows.filter((r) => r.q.answerable);
  const unanswerable = rows.filter((r) => !r.q.answerable);
  const cited = answerable.filter((r) => r.citedMs.some((c) => r.q.expect.some((e) => c >= e.startMs - CITATION_SLACK_MS && c <= e.endMs + CITATION_SLACK_MS)));
  const quoting = rows.filter((r) => r.quotesFound.length > 0);
  const exact = quoting.filter((r) => r.quotesFound.every(Boolean));
  const refused = unanswerable.filter((r) => REFUSALS.some((p) => r.answer.includes(p)));
  return {
    citationHit: share(cited.length, answerable.length),
    quoteExact: share(exact.length, quoting.length),
    refusalCorrect: share(refused.length, unanswerable.length),
    n: rows.length,
  };
}

/** Times cited as [hh:mm:ss], [mm:ss] or a range [hh:mm:ss–hh:mm:ss], and the text in straight or curly double quotes. */
export function parseCitations(answer: string): { citedMs: number[]; quotes: string[] } {
  // Every timestamp inside a square bracket, so a range [a–b] or a list [a; b] gives each of its times.
  const citedMs = [...answer.matchAll(/\[([^\]]*)\]/g)].flatMap((bracket) =>
    [...bracket[1]!.matchAll(/\d{1,2}(?::\d{2}){1,2}/g)].flatMap((m) => {
      try {
        return [parseTimestamp(m[0])];
      } catch {
        return [];
      }
    }),
  );
  const quotes = [...answer.matchAll(/["“„]([^"”“„]{8,}?)["”“]/g)].map((m) => m[1]!.trim());
  return { citedMs, quotes };
}
