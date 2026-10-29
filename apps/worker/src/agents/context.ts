import { z } from "zod";
import {
  ContextCardSchema,
  EVENT_TYPES,
  QuestionSchema,
  renderTranscript,
  speakerShares,
  toSentences,
  type ContextCard,
  type Fact,
  type Participant,
  type Question,
  type Word,
} from "@digestor/core";
import type { StructuredLLM } from "../llm/structured.js";

export type ContextInput = {
  words: Word[];
  metadata: Record<string, string>;
  hint: string | null;
  answers: { question: string; answer: string }[];
  locked: Partial<ContextCard>;
  language: { code: string; confidence: number };
};

const NULL_FACT: Fact = { value: null, source: null, evidence: null };
const MAX_QUESTIONS = 3;

/** LLM output schema: like ContextCardSchema but without the question cap, which assessSufficiency applies in code. */
export const ContextCardOutput = ContextCardSchema.extend({ openQuestions: z.array(QuestionSchema) });
const MIN_EVENT_CONFIDENCE = 0.6;
const MIN_SPEAKER_SHARE = 0.1;

export function buildContextPrompt(i: ContextInput): { system: string; user: string } {
  const eventTypes = Object.entries(EVENT_TYPES)
    .map(([id, c]) => `- ${id}: ${c.label}`)
    .join("\n");
  const system = [
    "You build a context card for a video transcript, so that later steps understand who is speaking and what the event is.",
    "",
    "Event types (pick exactly one for eventType.value):",
    eventTypes,
    "",
    "Evidence rule: every fact must quote the exact transcript sentence, metadata value, or human text that supports it; otherwise null.",
    'A fact is {value, source, evidence}. source is "video" (transcript), "metadata" or "human" (hint or answers). If nothing supports a fact, use {value: null, source: null, evidence: null}. Never guess names, roles, dates or places.',
    "Quote sentence text only in evidence: no [hh:mm:ss] or speaker prefix.",
    "The summary must not state names, dates or places that are not supported facts.",
    "Do not report the language; it is detected separately. Set language to {value: null, source: null, evidence: null}.",
    "List one participant per speaker id that appears in the transcript.",
    "",
    "Question rules: ask at most 3 questions (max 3), in plain language a non-expert understands, most important first. Only ask about things you could not establish. Use target date, event_type, participant (with speakerId) or other. Sufficiency is computed separately; just list your open questions.",
  ].join("\n");

  const meta = Object.entries(i.metadata)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const answers = i.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n");
  const user = [
    "## Metadata",
    meta || "(none)",
    "",
    "## Hint from the human",
    i.hint ?? "(none)",
    "",
    "## Answers from the human",
    answers || "(none)",
    "",
    "## Transcript",
    renderTranscript(toSentences(i.words)),
  ].join("\n");
  return { system, user };
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\p{P}/gu, "").replace(/\s+/g, " ").trim();
}

type Sources = Record<"video" | "metadata" | "human", string>;

function normEvidence(evidence: string): string {
  return normalise(evidence.replace(/^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*[^:]{1,20}:\s*/, ""));
}

function hasWords(haystack: string, needle: string): boolean {
  return needle !== "" && ` ${haystack} `.includes(` ${needle} `);
}

function supported(fact: Fact, sources: Sources): boolean {
  if (fact.value === null) return true;
  if (fact.source === null || fact.evidence === null) return false;
  return hasWords(sources[fact.source], normEvidence(fact.evidence));
}

export function groundContext(card: ContextCard, i: ContextInput): ContextCard {
  const sources = {
    video: normalise(toSentences(i.words).map((s) => s.text).join(" ")),
    metadata: normalise(Object.values(i.metadata).join(" ")),
    human: normalise([i.hint ?? "", ...i.answers.map((a) => a.answer)].join(" ")),
  };
  const ground = (f: Fact): Fact => (supported(f, sources) ? f : { ...NULL_FACT });
  const groundName = (f: Fact): Fact => {
    const g = ground(f);
    if (g.value === null) return g;
    return hasWords(normEvidence(g.evidence ?? ""), normalise(g.value)) ? g : { ...NULL_FACT };
  };
  const evType = card.eventType;
  const evSupported =
    evType.evidence !== null &&
    Object.values(sources).some((src) => hasWords(src, normEvidence(evType.evidence ?? "")));

  const out: ContextCard = {
    ...card,
    eventType: evSupported ? evType : { ...evType, confidence: Math.min(evType.confidence, 0.5) },
    title: ground(card.title),
    setting: ground(card.setting),
    dateOrYear: ground(card.dateOrYear),
    participants: card.participants.map((p) => ({
      ...p,
      name: groundName(p.name),
      role: ground(p.role),
      affiliation: ground(p.affiliation),
    })),
  };

  // Human-locked values override, always with source "human".
  const human = (f: Fact): Fact => (f.value !== null ? { ...f, source: "human" } : { ...NULL_FACT });
  const l = i.locked;
  if (l.language) out.language = human(l.language);
  if (l.title) out.title = human(l.title);
  if (l.setting) out.setting = human(l.setting);
  if (l.dateOrYear) out.dateOrYear = human(l.dateOrYear);
  if (l.eventType) out.eventType = l.eventType;
  if (l.summary !== undefined) out.summary = l.summary;
  for (const lp of l.participants ?? []) {
    const locked: Participant = {
      speakerId: lp.speakerId,
      name: human(lp.name),
      role: human(lp.role),
      affiliation: human(lp.affiliation),
    };
    const idx = out.participants.findIndex((p) => p.speakerId === lp.speakerId);
    if (idx >= 0) {
      const cur = out.participants[idx]!;
      const pick = (lf: Fact, cf: Fact): Fact => (lf.value !== null ? lf : cf);
      out.participants[idx] = {
        speakerId: lp.speakerId,
        name: pick(locked.name, cur.name),
        role: pick(locked.role, cur.role),
        affiliation: pick(locked.affiliation, cur.affiliation),
      };
    } else {
      out.participants.push(locked);
    }
  }
  return out;
}

export function assessSufficiency(card: ContextCard, words: Word[]): ContextCard {
  const shares = speakerShares(words);
  const unidentified = Object.entries(shares)
    .filter(([, share]) => share >= MIN_SPEAKER_SHARE)
    .map(([id]) => id)
    .filter((id) => {
      const p = card.participants.find((x) => x.speakerId === id);
      return !p || (p.name.value === null && p.role.value === null);
    });
  const missingDate = card.dateOrYear.value === null;
  const lowEvent = card.eventType.confidence < MIN_EVENT_CONFIDENCE;
  const sufficient = !lowEvent && !missingDate && unidentified.length === 0;

  if (sufficient) return { ...card, sufficient: true, openQuestions: [] };

  const fallbacks: Omit<Question, "id">[] = [];
  if (missingDate) {
    fallbacks.push({
      target: "date",
      speakerId: null,
      question: "When was this recorded or first aired?",
      why: "The date helps interpret what speakers refer to.",
      sampleStartMs: null,
    });
  }
  if (lowEvent) {
    fallbacks.push({
      target: "event_type",
      speakerId: null,
      question: "What kind of event is this?",
      why: "The event type decides what counts as a highlight.",
      sampleStartMs: null,
    });
  }
  for (const id of unidentified) {
    fallbacks.push({
      target: "participant",
      speakerId: id,
      question: `Who is Speaker ${id}?`,
      why: "Knowing who speaks helps label the clips.",
      sampleStartMs: words.find((w) => w.speaker === id)?.startMs ?? null,
    });
  }

  const llmQuestions = card.openQuestions
    .filter((q) => q.target !== "participant" || (q.speakerId !== null && q.speakerId in shares))
    .map((q) =>
      q.target === "participant"
        ? { ...q, sampleStartMs: words.find((w) => w.speaker === q.speakerId)?.startMs ?? null }
        : q,
    );
  const covers = (q: Omit<Question, "id">): boolean =>
    (q.target === "date" && missingDate) ||
    (q.target === "event_type" && lowEvent) ||
    (q.target === "participant" && q.speakerId !== null && unidentified.includes(q.speakerId));
  const ordered = [
    ...llmQuestions.filter(covers),
    ...fallbacks,
    ...llmQuestions.filter((q) => !covers(q)),
  ];

  const seen = new Set<string>();
  const questions: Question[] = [];
  let otherN = 0;
  for (const q of ordered) {
    const key = `${q.target}|${q.speakerId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id =
      q.target === "date"
        ? "date"
        : q.target === "event_type"
          ? "event_type"
          : q.target === "participant"
            ? `participant:${q.speakerId ?? ""}`
            : `other:${++otherN}`;
    questions.push({ ...q, id });
  }
  return { ...card, sufficient: false, openQuestions: questions.slice(0, MAX_QUESTIONS) };
}

export async function understandContext(llm: StructuredLLM, i: ContextInput): Promise<ContextCard> {
  const { system, user } = buildContextPrompt(i);
  const draft = await llm.generate({ schema: ContextCardOutput, name: "context_card", system, user, model: "reasoning" });
  const withLanguage: ContextCard = {
    ...draft,
    language: {
      value: i.language.code,
      source: "video",
      evidence: `detected from audio (confidence ${i.language.confidence.toFixed(2)})`,
    },
  };
  return assessSufficiency(groundContext(withLanguage, i), i.words);
}
