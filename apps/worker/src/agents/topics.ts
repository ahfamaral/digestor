import { z } from "zod";
import {
  InvalidTimestampError,
  PROFILES,
  findBoundaries,
  formatTimestamp,
  parseTimestamp,
  renderTranscript,
  snapRange,
  toSentences,
  type Boundary,
  type ContextCard,
  type Transcript,
} from "@digestor/core";
import { MissingApiKeyError } from "../errors.js";
import type { StructuredLLM } from "../llm/structured.js";

export const MAX_TOPICS = 30;
export const MIN_TOPIC_MS = 60_000;

export type DraftTopic = { title: string; summary: string; startMs: number; endMs: number };

/** Lenient on purpose: timestamps are plain strings, counts and lengths are enforced in code. */
export const TopicsOutput = z.object({
  topics: z.array(
    z.object({
      title: z.string().describe("Short title, in the original language of the session"),
      summary: z.string().describe("At most 2 sentences, in the original language"),
      start: z.string().describe("hh:mm:ss, where the topic begins"),
      end: z.string().describe("hh:mm:ss, where the topic ends"),
    }),
  ),
});

export function buildTopicsPrompt(a: { card: ContextCard; transcript: Transcript }): { system: string; user: string } {
  const profile = PROFILES[a.card.profile.value];
  const system = [
    "You split a long public-interest video into topics so a reader can navigate it.",
    "",
    "Context card:",
    JSON.stringify(a.card, null, 2),
    "",
    `Topics are ${profile.topicDefinition}.`,
    "",
    "Hard rules:",
    "- Topics cover the whole session, in order, without gaps or overlaps: each topic starts where the previous one ends.",
    `- Propose at most ${MAX_TOPICS} topics, none shorter than 1 minute.`,
    "- Write every title and summary in the original language of the transcript.",
    "- Each summary has at most 2 sentences.",
    "- Give start and end as hh:mm:ss, matching the [hh:mm:ss] line prefixes of the transcript.",
  ].join("\n");
  const user = [
    `Video duration: ${formatTimestamp(a.transcript.durationMs)}.`,
    "",
    "Transcript:",
    renderTranscript(toSentences(a.transcript.words)),
  ].join("\n");
  return { system, user };
}

/** Merge topic i into its neighbour j; the result keeps the title/summary of the longer side. */
function mergePair(topics: DraftTopic[], i: number): DraftTopic[] {
  const a = topics[i]!;
  const b = topics[i + 1]!;
  const keep = a.endMs - a.startMs >= b.endMs - b.startMs ? a : b;
  const merged = { title: keep.title, summary: keep.summary, startMs: a.startMs, endMs: b.endMs };
  return [...topics.slice(0, i), merged, ...topics.slice(i + 2)];
}

export function normalizeTopics(
  raw: z.infer<typeof TopicsOutput>,
  o: { durationMs: number; boundaries: Boundary[] },
): DraftTopic[] {
  const starts: { title: string; summary: string; startMs: number }[] = [];
  for (const t of raw.topics) {
    let startMs: number;
    let endMs: number;
    try {
      startMs = parseTimestamp(t.start);
      endMs = parseTimestamp(t.end);
    } catch (err) {
      if (err instanceof InvalidTimestampError) continue;
      throw err;
    }
    if (startMs >= o.durationMs || t.title.trim() === "") continue;
    startMs = Math.max(0, startMs);
    endMs = Math.min(Math.max(endMs, startMs + 1), o.durationMs);
    if (o.boundaries.length >= 2) startMs = snapRange(o.boundaries, { startMs, endMs }).startMs;
    starts.push({ title: t.title.trim(), summary: t.summary.trim(), startMs });
  }
  starts.sort((a, b) => a.startMs - b.startMs);
  // Contiguity is forced here: the first topic starts at 0, each topic ends where the next starts.
  const unique = starts.filter((t, i) => i === 0 || t.startMs > starts[i - 1]!.startMs);
  let topics: DraftTopic[] = unique.map((t, i) => ({
    title: t.title,
    summary: t.summary,
    startMs: i === 0 ? 0 : t.startMs,
    endMs: unique[i + 1]?.startMs ?? o.durationMs,
  }));

  // Tiny topics merge into the previous one (the first into the next); the neighbour's title wins.
  for (;;) {
    if (topics.length < 2) break;
    const i = topics.findIndex((t) => t.endMs - t.startMs < MIN_TOPIC_MS);
    if (i === -1) break;
    const pair = i === 0 ? 0 : i - 1;
    const neighbour = topics[i === 0 ? 1 : i - 1]!;
    const merged = { ...neighbour, startMs: topics[pair]!.startMs, endMs: topics[pair + 1]!.endMs };
    topics = [...topics.slice(0, pair), merged, ...topics.slice(pair + 2)];
  }

  // Too many: merge the adjacent pair with the smallest combined length first.
  while (topics.length > MAX_TOPICS) {
    let best = 0;
    let bestLen = Infinity;
    for (let i = 0; i < topics.length - 1; i++) {
      const len = topics[i + 1]!.endMs - topics[i]!.startMs;
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    }
    topics = mergePair(topics, best);
  }
  return topics;
}

function fallback(durationMs: number): DraftTopic[] {
  return [{ title: "Whole session", summary: "", startMs: 0, endMs: durationMs }];
}

export async function findTopics(
  llm: StructuredLLM,
  a: { card: ContextCard; transcript: Transcript },
): Promise<DraftTopic[]> {
  const { words, durationMs } = a.transcript;
  if (words.length === 0) return fallback(durationMs);
  const boundaries = findBoundaries(words, durationMs);
  try {
    const res = await llm.generate({
      schema: TopicsOutput,
      name: "topics",
      ...buildTopicsPrompt(a),
      model: "reasoning",
    });
    const topics = normalizeTopics(res, { durationMs, boundaries });
    return topics.length > 0 ? topics : fallback(durationMs);
  } catch (err) {
    if (err instanceof MissingApiKeyError) throw err; // deterministic: fail the session (Ruling R8)
    // The session must not die on topics: one whole-session topic is a usable briefing skeleton.
    console.error("[topics] topic finder failed, using one whole-session topic:", err);
    return fallback(durationMs);
  }
}
