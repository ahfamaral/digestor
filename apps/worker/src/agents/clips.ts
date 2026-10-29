import { z } from "zod";
import {
  CandidateSchema,
  EVENT_TYPES,
  InvalidTimestampError,
  findBoundaries,
  fitChildInParent,
  formatTimestamp,
  overlapRatio,
  parseTimestamp,
  renderTranscript,
  sliceWords,
  snapRange,
  toSentences,
  type Boundary,
  type Candidate,
  type ContextCard,
  type ProposedClip,
  type Transcript,
  type Word,
} from "@digestor/core";
import type { StructuredLLM } from "../llm/structured.js";

export const LongClipsOutput = z.object({ clips: z.array(CandidateSchema).max(25) });
export const HotTakesOutput = z.object({ hotTakes: z.array(CandidateSchema).max(4) });

type Clip = Omit<ProposedClip, "children">;

const HOT_TAKE_LIMITS = { minMs: 8_000, maxMs: 120_000 };
const PASS2_CONCURRENCY = 4;
const MAX_OVERLAP = 0.6;

export function longClipLimits(durationMs: number): { minMs: number; maxMs: number } {
  const maxMs = 1_200_000;
  return durationMs < 480_000 ? { minMs: Math.max(30_000, durationMs / 4), maxMs } : { minMs: 60_000, maxMs };
}

const LABEL_DEFINITIONS = [
  "Labels:",
  "- heated: open disagreement, raised voices, interruptions, sharp pushback.",
  "- key_point: a concrete claim, figure, announcement or revealing answer.",
  "- light: humour, laughter, a warm or surprising human moment.",
].join("\n");

function languageName(card: ContextCard): string {
  return card.language.value ?? "the language spoken in the transcript";
}

function commonSystem(card: ContextCard, role: string, rules: string[]): string {
  const type = EVENT_TYPES[card.eventType.value];
  const parts = [
    role,
    "",
    "Context card:",
    JSON.stringify(card, null, 2),
    "",
    `What to look for (${type.label}): ${type.rubric}`,
    "",
    LABEL_DEFINITIONS,
    "",
    "Hard rules:",
    ...rules.map((r) => `- ${r}`),
  ];
  if (type.fewShot.length > 0) parts.push("", "Examples:", ...type.fewShot);
  return parts.join("\n");
}

const TIMESTAMP_RULE =
  "Give start and end as hh:mm:ss, matching the [hh:mm:ss] line prefixes of the transcript.";

export function buildLongClipPrompt(a: { card: ContextCard; words: Word[]; durationMs: number }): {
  system: string;
  user: string;
} {
  const { minMs, maxMs } = longClipLimits(a.durationMs);
  const system = commonSystem(
    a.card,
    "You are an editor who finds the most compelling long clips in a video transcript.",
    [
      "Each clip must be a complete exchange: it starts where a question or topic begins and ends where it resolves.",
      "Never start or end a clip in the middle of a sentence.",
      `Write every title in ${languageName(a.card)}.`,
      `Propose between 15 and 25 candidates, each between ${Math.round(minMs / 1000)} seconds and ${Math.round(maxMs / 60_000)} minutes long (ideally 2 to 12 minutes).`,
      "Write the reason first, then choose the label and score (0-100), then give the timestamps.",
      "Include in evidence short quotes from the transcript that justify the clip.",
      TIMESTAMP_RULE,
    ],
  );
  const user = [
    `Video duration: ${formatTimestamp(a.durationMs)}.`,
    "",
    "Transcript:",
    renderTranscript(toSentences(a.words)),
  ].join("\n");
  return { system, user };
}

export function buildHotTakePrompt(a: { card: ContextCard; parent: ProposedClip; words: Word[] }): {
  system: string;
  user: string;
} {
  const system = commonSystem(
    a.card,
    "You are an editor who finds the sharpest short hot takes inside a long clip of a video.",
    [
      "Every hot take must lie entirely inside the long clip's time range.",
      "Never start or end a hot take in the middle of a sentence.",
      `Write every title in ${languageName(a.card)}.`,
      "Propose at most 4 hot takes, each between 15 and 90 seconds long (never under 8 seconds or over 120 seconds).",
      "Write the reason first, then choose the label and score (0-100), then give the timestamps.",
      "Include in evidence short quotes from the transcript that justify the hot take.",
      TIMESTAMP_RULE,
    ],
  );
  const user = [
    `Long clip: "${a.parent.title}" from ${formatTimestamp(a.parent.startMs)} to ${formatTimestamp(a.parent.endMs)}.`,
    "",
    "Transcript of the long clip:",
    renderTranscript(toSentences(sliceWords(a.words, a.parent))),
  ].join("\n");
  return { system, user };
}

export function normalizeCandidates(
  c: Candidate[],
  o: { durationMs: number; boundaries: Boundary[]; minMs: number; maxMs: number },
): Clip[] {
  if (o.boundaries.length < 2) return [];
  const clips: Clip[] = [];
  for (const cand of c) {
    let startMs: number;
    let endMs: number;
    try {
      startMs = parseTimestamp(cand.start);
      endMs = parseTimestamp(cand.end);
    } catch (err) {
      if (err instanceof InvalidTimestampError) continue;
      throw err;
    }
    if (endMs <= startMs) continue;
    startMs = Math.min(Math.max(startMs, 0), o.durationMs);
    endMs = Math.min(Math.max(endMs, 0), o.durationMs);
    if (endMs <= startMs) continue;
    const snapped = snapRange(o.boundaries, { startMs, endMs });
    const len = snapped.endMs - snapped.startMs;
    if (len < o.minMs || len > o.maxMs) continue;
    clips.push({ title: cand.title, reason: cand.reason, label: cand.label, score: cand.score, ...snapped });
  }
  return dedupe(clips).sort((a, b) => b.score - a.score || a.startMs - b.startMs);
}

/** Keeps the higher score of any pair overlapping > 0.6 (ties: earlier start). */
function dedupe(clips: Clip[]): Clip[] {
  const ordered = [...clips].sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const kept: Clip[] = [];
  for (const clip of ordered) {
    if (!kept.some((k) => overlapRatio(k, clip) > MAX_OVERLAP)) kept.push(clip);
  }
  return kept;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export async function findClips(
  llm: StructuredLLM,
  a: { card: ContextCard; transcript: Transcript },
): Promise<ProposedClip[]> {
  const { words, durationMs } = a.transcript;
  if (words.length === 0) return [];
  const boundaries = findBoundaries(words, durationMs);

  const long = buildLongClipPrompt({ card: a.card, words, durationMs });
  const pass1 = await llm.generate({ schema: LongClipsOutput, name: "long_clips", ...long, model: "reasoning" });
  const parents = normalizeCandidates(pass1.clips, { durationMs, boundaries, ...longClipLimits(durationMs) });

  return mapPool(parents, PASS2_CONCURRENCY, async (parent): Promise<ProposedClip> => {
    const withChildren: ProposedClip = { ...parent, children: [] };
    const prompt = buildHotTakePrompt({ card: a.card, parent: withChildren, words });
    const res = await llm.generate({ schema: HotTakesOutput, name: "hot_takes", ...prompt, model: "reasoning" });
    const fitted: Clip[] = [];
    for (const child of normalizeCandidates(res.hotTakes, { durationMs, boundaries, ...HOT_TAKE_LIMITS })) {
      const fit = fitChildInParent(child, parent);
      if (fit) fitted.push({ ...child, ...fit });
    }
    return { ...parent, children: dedupe(fitted).sort((x, y) => x.startMs - y.startMs) };
  });
}
