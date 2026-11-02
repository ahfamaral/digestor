import {
  FOCUS_MIN_MS,
  findBoundaries,
  personAt,
  renderTranscript,
  sliceWords,
  speakersIn,
  toSentences,
  type Attribution,
  type ContextCard,
  type Range,
  type Topic,
  type Transcript,
  type Word,
} from "@digestor/core";
import type { NewMoment } from "@digestor/core/server";
import type { StructuredLLM } from "../llm/structured.js";
import {
  MomentsOutput,
  ORDER_RULE,
  TIMESTAMP_RULE,
  aiTypes,
  commonSystem,
  languageName,
  normalizeMoments,
  range,
} from "./moments.js";

/** Cost cap (spec §8.3): about 40k tokens of transcript; the person's turns are cut to fit. */
export const FIND_MORE_MAX_CHARS = 160_000;
export const MAX_FIND_MORE_MOMENTS = 20;
/** Context kept around each of the person's turns, so a moment can start at the question that led to it. */
/** Room left in the user text for its heading lines, so the whole text stays under FIND_MORE_MAX_CHARS. */
const PROMPT_HEADROOM = 400;
/** When the cap forces cuts, a stretch is split into pieces of at most this. */
const MAX_PIECE_MS = 10 * 60_000;
export const FIND_MORE_CONTEXT_MS = 30_000;

/**
 * The stretches where `personId` speaks: runs of consecutive words that resolve to them, word by word (a part of a
 * voice named differently stays out). In a sensitive profile an unconfirmed name doesn't count (the Focus rule).
 */
export function personTurnRanges(words: Word[], atts: Attribution[], personId: string, sensitive: boolean): Range[] {
  const turns: Range[] = [];
  let open = false;
  for (const w of words) {
    const res = personAt(atts, w.speaker, w.startMs);
    const is = res.kind === "named" && res.personId === personId && (res.confirmed || !sensitive);
    const last = turns[turns.length - 1];
    if (is && open && last) last.endMs = w.endMs;
    else if (is) turns.push({ startMs: w.startMs, endMs: w.endMs });
    open = is;
  }
  return turns;
}

function mergeRanges(rs: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...rs].sort((a, b) => a.startMs - b.startMs)) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

const overlapMs = (a: Range, b: Range) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/**
 * The person's turns, each with `marginMs` around it and merged, as the transcript the model reads (the person's lines
 * carry their name). Over `cap` characters, the longest stretches are kept until it is reached.
 */
function windowsText(words: Word[], turns: Range[], durationMs: number, marginMs: number, name: string, cap: number): string {
  const windows = mergeRanges(turns.map((t) => ({ startMs: Math.max(0, t.startMs - marginMs), endMs: Math.min(durationMs, t.endMs + marginMs) })));
  const render = (w: Range) =>
    renderTranscript(
      toSentences(sliceWords(words, w)).map((s) => ({ ...s, speaker: turns.some((t) => t.startMs <= s.startMs && s.startMs < t.endMs) ? name : s.speaker })),
    );
  let parts = windows.map((w) => ({ w, text: render(w) }));
  if (parts.reduce((n, p) => n + p.text.length + 2, 0) > cap) {
    // A stretch that is itself too long (one person talking for hours) is cut into pieces, so some of it still fits.
    parts = windows
      .flatMap((w) => {
        const n = Math.ceil((w.endMs - w.startMs) / MAX_PIECE_MS);
        return Array.from({ length: n }, (_, i) => ({
          startMs: w.startMs + Math.round(((w.endMs - w.startMs) * i) / n),
          endMs: w.startMs + Math.round(((w.endMs - w.startMs) * (i + 1)) / n),
        }));
      })
      .map((w) => ({ w, text: render(w) }));
    const kept: typeof parts = [];
    let used = 0;
    for (const p of [...parts].sort((x, y) => y.w.endMs - y.w.startMs - (x.w.endMs - x.w.startMs))) {
      if (used + p.text.length + 2 > cap) continue;
      kept.push(p);
      used += p.text.length + 2;
    }
    parts = kept.sort((x, y) => x.w.startMs - y.w.startMs);
  }
  return parts.map((p) => p.text).join("\n\n");
}

/**
 * One `reasoning` call over the person's turns (and the 30 s around each; less when that would pass the cap): the
 * same rubric as `findMoments`, all three granularities, snapped and normalised the same way. Moments where the person
 * speaks under 3 s are dropped, at most 20 kept. Errors propagate: the job decides on retry.
 */
export async function findMoreMoments(
  llm: StructuredLLM,
  a: { card: ContextCard; transcript: Transcript; topics: Topic[]; personTurns: Range[]; personName: string },
): Promise<NewMoment[]> {
  const { words, durationMs } = a.transcript;
  if (words.length === 0 || a.personTurns.length === 0) return [];
  const boundaries = findBoundaries(words, durationMs);
  const types = aiTypes(a.card);

  // 30 s around each turn; if that passes the cap, the turns alone, and if those do too, the longest windows.
  const cap = FIND_MORE_MAX_CHARS - PROMPT_HEADROOM;
  let text = windowsText(words, a.personTurns, durationMs, FIND_MORE_CONTEXT_MS, a.personName, Infinity);
  if (text.length > cap) text = windowsText(words, a.personTurns, durationMs, 0, a.personName, cap);

  const system = commonSystem(a.card, `You are an editor who finds the most worth-showing moments in what ${a.personName} says in a long video.`, [
    `Propose moments of all three granularities, marked in granularity: exchange (${range("exchange")}), passage (${range("passage")}) and punchline (${range("punchline")}); at most ${MAX_FIND_MORE_MOMENTS} moments in all.`,
    `Every moment must be mostly ${a.personName} speaking (their lines are marked with their name), at least ${FOCUS_MIN_MS / 1000} seconds of it.`,
    "Never start or end a moment in the middle of a sentence.",
    `Write every title and why in ${languageName(a.card)}.`,
    ORDER_RULE,
    "Put in evidence short verbatim quotes from the transcript that justify the moment.",
    TIMESTAMP_RULE,
  ]);
  const user = [
    `Focus person: ${a.personName}`,
    "",
    `Transcript of ${a.personName}'s turns, with the lines around them (separate stretches are divided by a blank line):`,
    text,
  ].join("\n");

  const res = await llm.generate({ schema: MomentsOutput, name: "find_more", system, user, model: "reasoning" });
  const drafts = normalizeMoments(res.moments, {
    durationMs,
    boundaries,
    within: { startMs: 0, endMs: durationMs },
    allowed: ["exchange", "passage", "punchline"],
    types,
  })
    .filter((d) => a.personTurns.reduce((n, t) => n + overlapMs(d, t), 0) >= FOCUS_MIN_MS)
    .slice(0, MAX_FIND_MORE_MOMENTS);

  return drafts.map((d) => {
    const mid = (d.startMs + d.endMs) / 2;
    return {
      topicId: a.topics.find((t) => t.startMs <= mid && mid < t.endMs)?.id ?? null,
      granularity: d.granularity,
      startMs: d.startMs,
      endMs: d.endMs,
      title: d.title,
      why: d.why,
      relevance: d.relevance,
      speakers: speakersIn(words, d),
      evidence: d.evidence,
      origin: "find_more" as const,
      highlights: d.highlightTypes.map((type) => ({ type, method: "ai" as const, value: null })),
    };
  });
}
