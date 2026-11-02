import { z } from "zod";
import {
  GRANULARITY,
  HIGHLIGHT_TYPES,
  HighlightTypeIdSchema,
  InvalidTimestampError,
  PROFILES,
  findBoundaries,
  formatTimestamp,
  insideOf,
  longestSpeech,
  overlapRatio,
  parseTimestamp,
  renderTranscript,
  sliceWords,
  snapRange,
  speakersIn,
  toSentences,
  type Boundary,
  type ContextCard,
  type Granularity,
  type HighlightTypeId,
  type Range,
  type Topic,
  type Transcript,
  type Word,
} from "@digestor/core";
import type { NewMoment } from "@digestor/core/server";
import { MissingApiKeyError } from "../errors.js";
import type { StructuredLLM } from "../llm/structured.js";

export const PASS_CONCURRENCY = 4;
export const MAX_OVERLAP = 0.6;
export const MAX_EXCHANGES_PER_TOPIC = 8;
export const MAX_PASSAGES_PER_TOPIC = 12;
export const MIN_PUNCHLINES_PER_EXCHANGE = 4;
export const MAX_PUNCHLINES_PER_EXCHANGE = 8;
/** One punchline allowed per this much exchange, so a long debate round keeps more than its first few lines. */
export const PUNCHLINE_EVERY_MS = 45_000;
export const MAX_MOMENTS = 250;
/** Cost cap (Ruling R9): only the most relevant exchanges session-wide get a punchline call. */
export const MAX_PUNCHLINE_PARENTS = 40;
/** Slack when checking that a model range lies inside its topic/exchange; the result is clamped to the parent anyway. */
const WITHIN_SLACK_MS = 2_000;

/**
 * Lenient on purpose (see llm-structured-output): strings and plain numbers only. Timestamps, types, ranges,
 * lengths and caps are enforced per item in normalizeMoments. Key order makes the model reason first.
 */
export const LlmMomentSchema = z.object({
  title: z.string().describe("Short title, in the original language of the session"),
  why: z.string().describe("One or two sentences: why this moment matters. Write this first."),
  highlightTypes: z.array(z.string()).describe("Ids of the highlight types that apply, from the list in the prompt"),
  relevance: z.union([z.number(), z.string()]).describe("0-100: how worth showing this moment is"),
  granularity: z.string().describe("exchange, passage or punchline"),
  start: z.string().describe("hh:mm:ss, where the moment begins"),
  end: z.string().describe("hh:mm:ss, where the moment ends"),
  evidence: z.array(z.string()).describe("Short verbatim quotes from the transcript that justify the moment"),
});
export type LlmMoment = z.infer<typeof LlmMomentSchema>;
export const MomentsOutput = z.object({ moments: z.array(LlmMomentSchema) });
export const PunchlinesOutput = z.object({ punchlines: z.array(LlmMomentSchema) });

export type DraftMoment = {
  title: string;
  why: string;
  granularity: Granularity;
  startMs: number;
  endMs: number;
  relevance: number;
  highlightTypes: HighlightTypeId[];
  evidence: string[];
};

const isGranularity = (g: string): g is Granularity => g in GRANULARITY;

export function normalizeMoments(
  raw: LlmMoment[],
  o: { durationMs: number; boundaries: Boundary[]; within: Range; allowed: Granularity[]; types: HighlightTypeId[] },
): DraftMoment[] {
  if (o.boundaries.length < 2) return [];
  const out: DraftMoment[] = [];
  for (const r of raw) {
    const g = r.granularity.trim().toLowerCase();
    if (!isGranularity(g) || !o.allowed.includes(g)) continue;
    let startMs: number;
    let endMs: number;
    try {
      startMs = parseTimestamp(r.start);
      endMs = parseTimestamp(r.end);
    } catch (err) {
      if (err instanceof InvalidTimestampError) continue;
      throw err;
    }
    if (endMs <= startMs) continue;
    if (startMs < o.within.startMs - WITHIN_SLACK_MS || endMs > o.within.endMs + WITHIN_SLACK_MS) continue;
    startMs = Math.max(startMs, 0);
    endMs = Math.min(endMs, o.durationMs);
    if (endMs <= startMs) continue;
    const snapped = snapRange(o.boundaries, { startMs, endMs });
    // The parent range is itself snapped, so clamping keeps the cut on a sentence boundary.
    const range = {
      startMs: Math.max(snapped.startMs, o.within.startMs),
      endMs: Math.min(snapped.endMs, o.within.endMs),
    };
    const [min, max] = GRANULARITY[g].acceptMs;
    const len = range.endMs - range.startMs;
    if (len < min || len > max) continue;
    const types = [...new Set(r.highlightTypes.map((t) => t.trim()))].filter(
      (t): t is HighlightTypeId => HighlightTypeIdSchema.safeParse(t).success && o.types.includes(t as HighlightTypeId),
    );
    const title = r.title.trim();
    if (title === "") continue;
    const relevance = typeof r.relevance === "number" ? r.relevance : r.relevance.trim() === "" ? NaN : Number(r.relevance);
    if (!Number.isFinite(relevance)) continue;
    out.push({
      title,
      why: r.why.trim(),
      granularity: g,
      ...range,
      relevance: Math.round(Math.min(100, Math.max(0, relevance))),
      highlightTypes: types,
      evidence: r.evidence.map((e) => e.trim()).filter((e) => e !== ""),
    });
  }
  return dedupe(out);
}

/** Keeps the more relevant of any pair of the same granularity overlapping > 0.6 (ties: earlier start). Sorted best first. */
export function dedupe<T extends Range & { relevance: number; granularity: Granularity }>(items: T[]): T[] {
  const ordered = [...items].sort((a, b) => b.relevance - a.relevance || a.startMs - b.startMs);
  const kept: T[] = [];
  for (const item of ordered) {
    if (!kept.some((k) => k.granularity === item.granularity && overlapRatio(k, item) > MAX_OVERLAP)) kept.push(item);
  }
  return kept;
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function languageName(card: ContextCard): string {
  return card.language.value ?? "the language spoken in the transcript";
}

function aiTypes(card: ContextCard): HighlightTypeId[] {
  return PROFILES[card.profile.value].highlightTypes.filter((t) => HIGHLIGHT_TYPES[t].method === "ai");
}

function commonSystem(card: ContextCard, role: string, rules: string[]): string {
  const profile = PROFILES[card.profile.value];
  const types = aiTypes(card);
  const parts = [
    role,
    "",
    "Context card:",
    JSON.stringify(card, null, 2),
    "",
    `What to look for (${profile.label}): ${profile.rubric}`,
    "",
    "Highlight types (use only these ids in highlightTypes):",
    ...types.map((t) => `- ${t}: ${HIGHLIGHT_TYPES[t].definition}`),
  ];
  if (types.includes("claim_to_check")) {
    parts.push("", "For claim_to_check: flag the claim, never judge it true or false.");
  }
  parts.push("", "Hard rules:", ...rules.map((r) => `- ${r}`));
  if (profile.fewShot.length > 0) parts.push("", "Examples:", ...profile.fewShot);
  return parts.join("\n");
}

const range = (g: Granularity) => {
  const { targetMs, acceptMs } = GRANULARITY[g];
  return `${targetMs[0] / 1000}-${targetMs[1] / 1000} seconds (never under ${acceptMs[0] / 1000} or over ${acceptMs[1] / 1000} seconds)`;
};
const TIMESTAMP_RULE = "Give start and end as hh:mm:ss, matching the [hh:mm:ss] line prefixes of the transcript.";
const ORDER_RULE = "For each moment write why first, then choose the highlight types and relevance (0-100), then give the timestamps.";

export function buildMomentsPrompt(a: { card: ContextCard; topic: Range & { title: string }; words: Word[] }): {
  system: string;
  user: string;
} {
  const system = commonSystem(a.card, "You are an editor who finds the most worth-showing moments inside one topic of a long video.", [
    "Propose two kinds of moments, marked in granularity: exchange and passage.",
    `exchange: a complete exchange that starts where a question or point begins and ends where it resolves; ${range("exchange")}; at most ${MAX_EXCHANGES_PER_TOPIC}.`,
    `passage: a single focused stretch, often inside an exchange; ${range("passage")}; at most ${MAX_PASSAGES_PER_TOPIC}.`,
    "Every moment must lie entirely inside the topic's time range.",
    "Never start or end a moment in the middle of a sentence.",
    `Write every title and why in ${languageName(a.card)}.`,
    ORDER_RULE,
    "Put in evidence short verbatim quotes from the transcript that justify the moment.",
    TIMESTAMP_RULE,
  ]);
  const user = [
    `Topic: "${a.topic.title}" from ${formatTimestamp(a.topic.startMs)} to ${formatTimestamp(a.topic.endMs)}.`,
    "",
    "Transcript of the topic:",
    renderTranscript(toSentences(sliceWords(a.words, a.topic))),
  ].join("\n");
  return { system, user };
}

/** Punchlines allowed in one exchange: one per 45 s of it, between 4 and 8. */
export function punchlineCap(exchange: Range): number {
  const n = Math.round((exchange.endMs - exchange.startMs) / PUNCHLINE_EVERY_MS);
  return Math.min(MAX_PUNCHLINES_PER_EXCHANGE, Math.max(MIN_PUNCHLINES_PER_EXCHANGE, n));
}

export function buildPunchlinesPrompt(a: { card: ContextCard; exchange: Range & { title: string }; words: Word[] }): {
  system: string;
  user: string;
} {
  const system = commonSystem(a.card, "You are an editor who finds the sharpest short punchlines inside one exchange of a video.", [
    "Every punchline must lie entirely inside the exchange's time range.",
    "Never start or end a punchline in the middle of a sentence.",
    `Each punchline has granularity punchline and is ${range("punchline")}; at most ${punchlineCap(a.exchange)}.`,
    `Write every title and why in ${languageName(a.card)}.`,
    ORDER_RULE,
    "Put in evidence short verbatim quotes from the transcript that justify the punchline.",
    TIMESTAMP_RULE,
  ]);
  const user = [
    `Exchange: "${a.exchange.title}" from ${formatTimestamp(a.exchange.startMs)} to ${formatTimestamp(a.exchange.endMs)}.`,
    "",
    "Transcript of the exchange:",
    renderTranscript(toSentences(sliceWords(a.words, a.exchange))),
  ].join("\n");
  return { system, user };
}

type Node = NewMoment & { parent?: Node };

export async function findMoments(
  llm: StructuredLLM,
  a: { card: ContextCard; transcript: Transcript; topics: Topic[] },
): Promise<NewMoment[]> {
  const { words, durationMs } = a.transcript;
  if (words.length === 0) return [];
  const boundaries = findBoundaries(words, durationMs);
  const types = aiTypes(a.card);

  const toNode = (d: DraftMoment, topicId: string | null): Node => ({
    topicId,
    granularity: d.granularity,
    startMs: d.startMs,
    endMs: d.endMs,
    title: d.title,
    why: d.why,
    relevance: d.relevance,
    speakers: speakersIn(words, d),
    evidence: d.evidence,
    origin: "ai",
    highlights: d.highlightTypes.map((type) => ({ type, method: "ai", value: null })),
  });

  // Pass A: exchanges and passages, one call per topic. A failed call costs only that topic.
  const perTopic = await mapPool(a.topics, PASS_CONCURRENCY, async (topic): Promise<Node[]> => {
    try {
      const res = await llm.generate({
        schema: MomentsOutput,
        name: "moments",
        ...buildMomentsPrompt({ card: a.card, topic, words }),
        model: "reasoning",
      });
      const drafts = normalizeMoments(res.moments, {
        durationMs,
        boundaries,
        within: topic,
        allowed: ["exchange", "passage"],
        types,
      });
      const exchanges = drafts.filter((d) => d.granularity === "exchange").slice(0, MAX_EXCHANGES_PER_TOPIC);
      const passages = drafts.filter((d) => d.granularity === "passage").slice(0, MAX_PASSAGES_PER_TOPIC);
      const exchangeNodes = exchanges.map((d) => toNode(d, topic.id));
      const passageNodes = passages.map((d) => {
        const n = toNode(d, topic.id);
        const i = insideOf(d, exchanges);
        if (i !== null) n.parent = exchangeNodes[i];
        return n;
      });
      return [...exchangeNodes, ...passageNodes];
    } catch (err) {
      if (err instanceof MissingApiKeyError) throw err; // deterministic: fail the session (Ruling R8)
      console.error(`[moments] moment call failed for topic "${topic.title}":`, err);
      return [];
    }
  });
  const pool: Node[] = perTopic.flat();

  // Pass B: punchlines, one call per kept exchange.
  const exchanges = pool
    .filter((n) => n.granularity === "exchange")
    .sort((x, y) => y.relevance - x.relevance || x.startMs - y.startMs)
    .slice(0, MAX_PUNCHLINE_PARENTS);
  let keyError: MissingApiKeyError | null = null; // once set, the pool issues no further calls
  const perExchange = await mapPool(exchanges, PASS_CONCURRENCY, async (ex): Promise<Node[]> => {
    if (keyError) return [];
    try {
      const res = await llm.generate({
        schema: PunchlinesOutput,
        name: "punchlines",
        ...buildPunchlinesPrompt({ card: a.card, exchange: ex, words }),
        model: "reasoning",
      });
      return normalizeMoments(res.punchlines, {
        durationMs,
        boundaries,
        within: ex,
        allowed: ["punchline"],
        types,
      })
        .slice(0, punchlineCap(ex))
        .map((d) => ({ ...toNode(d, ex.topicId), parent: ex }));
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        keyError ??= err;
        throw err; // deterministic: fail the session (Ruling R8)
      }
      console.error(`[moments] punchline call failed for "${ex.title}":`, err);
      return [];
    }
  });
  pool.push(...perExchange.flat());

  // Counted fact, not a cut suggestion: no upper length cap. Relevance 100 keeps it above AI picks in listings.
  const counted: Node[] = [];
  const speech = PROFILES[a.card.profile.value].highlightTypes.includes("longest_speech") ? longestSpeech(words) : null;
  if (speech && boundaries.length >= 2) {
    const r = snapRange(boundaries, speech);
    const mid = (r.startMs + r.endMs) / 2;
    const topic = a.topics.find((t) => t.startMs <= mid && mid < t.endMs) ?? null;
    counted.push({
      topicId: topic?.id ?? null,
      granularity: "exchange",
      ...r,
      title: `Longest speech: ${speech.speaker}`,
      why: `The longest uninterrupted speech in the session, by ${speech.speaker}, ${formatTimestamp(r.endMs - r.startMs)} long (counted from the transcript).`,
      relevance: 100,
      speakers: [speech.speaker],
      evidence: [],
      origin: "counted",
      highlights: [{ type: "longest_speech", method: "counted", value: Math.round((r.endMs - r.startMs) / 1000) }],
    });
  }

  const top = [...pool]
    .sort((x, y) => y.relevance - x.relevance || x.startMs - y.startMs)
    .slice(0, MAX_MOMENTS - counted.length);
  // Punchlines go with their exchange when the cap cuts it; a passage stays, just unlinked.
  const topSet = new Set(top);
  const ranked = top.filter((n) => n.granularity !== "punchline" || !n.parent || topSet.has(n.parent));
  const all = [...counted, ...ranked].sort((x, y) => y.relevance - x.relevance || x.startMs - y.startMs);
  const index = new Map(all.map((n, i) => [n, i]));
  return all.map(({ parent, ...n }) => {
    const idx = parent ? index.get(parent) : undefined;
    return idx === undefined ? n : { ...n, insideIdx: idx };
  });
}
