import { z } from "zod";
import {
  PROFILES,
  formatTimestamp,
  sliceWords,
  toSentences,
  type BriefingContent,
  type BriefingSentence,
  type ContextCard,
  type Moment,
  type Topic,
  type Word,
} from "@digestor/core";
import { MissingApiKeyError } from "../errors.js";
import type { StructuredLLM } from "../llm/structured.js";

export const MAX_LEAD_SENTENCES = 3;
export const MAX_SUMMARY_SENTENCES = 3;
export const MAX_MOMENTS_PER_TOPIC_IN_PROMPT = 12;
const EXCERPT_CHARS = 400;

const SentenceOut = z.object({
  text: z.string().describe("One sentence, in the original language of the session"),
  momentIds: z.array(z.string()).describe("Ids of the moments that support this sentence, from the list in the prompt"),
});

/** Lenient on purpose: counts, ids, quotes and topic indexes are checked in groundBriefing. */
export const BriefingOutput = z.object({
  lead: z.array(SentenceOut).describe("At most 3 sentences summarising the whole session"),
  sections: z.array(
    z.object({
      topicIdx: z.number().describe("The idx of the topic, as listed in the prompt"),
      summary: z.array(SentenceOut).describe("At most 3 sentences about this topic"),
      keyQuote: z
        .object({
          momentId: z.string(),
          text: z.string().describe("A verbatim quote from that moment, copied exactly from the transcript excerpt"),
        })
        .nullable(),
    }),
  ),
});
export type BriefingOutput = z.infer<typeof BriefingOutput>;

export function normalizeQuote(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/** The transcript span (as rendered) matching a quote, or null. Word-aligned; CJK compares without whitespace. */
export function matchQuote(quote: string, momentWords: Word[]): string | null {
  const wanted = normalizeQuote(quote);
  if (wanted === "" || momentWords.length === 0) return null;
  const norm = momentWords.map((w) => normalizeQuote(w.text));
  let from = -1;
  let to = -1;
  if (momentWords.some((w) => CJK.test(w.text))) {
    const target = wanted.replace(/\s+/g, "");
    let flat = "";
    const owner: number[] = [];
    norm.forEach((n, i) => {
      for (const ch of n.replace(/\s+/g, "")) {
        flat += ch;
        owner.push(i);
      }
    });
    const at = target === "" ? -1 : flat.indexOf(target);
    if (at >= 0) {
      from = owner[at]!;
      to = owner[at + [...target].length - 1]!;
    }
  } else {
    const tokens: string[] = [];
    const owner: number[] = [];
    norm.forEach((n, i) => {
      for (const t of n.split(" ")) {
        if (t !== "") {
          tokens.push(t);
          owner.push(i);
        }
      }
    });
    const q = wanted.split(" ");
    for (let i = 0; i + q.length <= tokens.length; i++) {
      if (q.every((t, j) => tokens[i + j] === t)) {
        from = owner[i]!;
        to = owner[i + q.length - 1]!;
        break;
      }
    }
  }
  if (from < 0) return null;
  return toSentences(momentWords.slice(from, to + 1)).map((x) => x.text).join(" ");
}

function groundSentences(sentences: BriefingSentence[], known: Set<string>, cap: number): BriefingSentence[] {
  const out: BriefingSentence[] = [];
  for (const s of sentences) {
    const text = s.text.trim();
    const momentIds = [...new Set(s.momentIds.filter((id) => known.has(id)))];
    if (text === "" || momentIds.length === 0) continue;
    out.push({ text, momentIds });
    if (out.length >= cap) break;
  }
  return out;
}

export function groundBriefing(
  raw: BriefingOutput,
  o: { moments: Moment[]; topics: Topic[]; words: Word[] },
): BriefingContent {
  const byId = new Map(o.moments.map((m) => [m.id, m]));
  const known = new Set(byId.keys());
  const byIdx = new Map(o.topics.map((t) => [t.idx, t]));
  const seen = new Set<number>();
  const sections: BriefingContent["sections"] = [];
  for (const s of raw.sections) {
    const topic = byIdx.get(s.topicIdx);
    if (!topic || seen.has(s.topicIdx)) continue;
    seen.add(s.topicIdx);
    let keyQuote: { momentId: string; text: string } | null = null;
    const m = s.keyQuote ? byId.get(s.keyQuote.momentId) : undefined;
    if (s.keyQuote && m) {
      const exact = matchQuote(s.keyQuote.text, sliceWords(o.words, m));
      if (exact) keyQuote = { momentId: m.id, text: exact };
    }
    sections.push({ topicId: topic.id, summary: groundSentences(s.summary, known, MAX_SUMMARY_SENTENCES), keyQuote });
  }
  const idxOf = new Map(o.topics.map((t) => [t.id, t.idx]));
  sections.sort((x, y) => idxOf.get(x.topicId)! - idxOf.get(y.topicId)!);
  const lead = groundSentences(raw.lead, known, MAX_LEAD_SENTENCES);
  if (lead.length === 0 && !sections.some((x) => x.summary.length > 0) && (raw.lead.length > 0 || raw.sections.length > 0)) {
    console.error("[briefing] grounding dropped everything the model wrote; the briefing is empty");
  }
  return { lead, sections };
}

export function buildBriefingPrompt(a: {
  card: ContextCard;
  topics: Topic[];
  moments: Moment[];
  words: Word[];
}): { system: string; user: string } {
  const profile = PROFILES[a.card.profile.value];
  const system = [
    `You write the briefing of a long public-interest video (${profile.label}) so a reader can understand it without watching.`,
    "",
    "Context card:",
    JSON.stringify(a.card, null, 2),
    "",
    "Hard rules:",
    `- Write a lead of at most ${MAX_LEAD_SENTENCES} sentences about the whole session.`,
    `- For each topic write a summary of at most ${MAX_SUMMARY_SENTENCES} sentences.`,
    "- Write in the original language of the transcript.",
    "- Every sentence cites the ids of the moments that support it, only from the list given. Never invent ids.",
    "- State only what the moments show. Do not add facts, names or numbers that are not in them.",
    "- Optionally give one keyQuote per topic: copy it word for word from a moment's excerpt, with that moment's id. Use null when unsure; never paraphrase a quote.",
  ].join("\n");
  const blocks = a.topics.map((t) => {
    const ms = a.moments
      .filter((m) => m.topicId === t.id)
      .sort((x, y) => y.relevance - x.relevance || x.startMs - y.startMs)
      .slice(0, MAX_MOMENTS_PER_TOPIC_IN_PROMPT);
    const lines = ms.map((m) => {
      const excerpt = sliceWords(a.words, m).map((w) => w.text).join(" ").slice(0, EXCERPT_CHARS);
      return `  - id=${m.id} [${formatTimestamp(m.startMs)}] ${m.title} | Why: ${m.why} | Excerpt: "${excerpt}"`;
    });
    return [`Topic idx=${t.idx} [${formatTimestamp(t.startMs)}-${formatTimestamp(t.endMs)}] ${t.title}`, ...lines].join("\n");
  });
  return { system, user: ["Topics and their top moments:", "", ...blocks].join("\n") };
}

export async function writeBriefing(
  llm: StructuredLLM,
  a: { card: ContextCard; topics: Topic[]; moments: Moment[]; words: Word[] },
): Promise<BriefingContent> {
  if (a.topics.length === 0) return { lead: [], sections: [] };
  try {
    const raw = await llm.generate({
      schema: BriefingOutput,
      name: "briefing",
      ...buildBriefingPrompt(a),
      model: "reasoning",
    });
    return groundBriefing(raw, a);
  } catch (err) {
    if (err instanceof MissingApiKeyError) throw err; // deterministic: fail the session (Ruling R8)
    console.error("[briefing] briefing writer failed, continuing without a briefing:", err);
    return { lead: [], sections: [] };
  }
}
