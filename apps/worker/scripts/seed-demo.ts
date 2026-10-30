/**
 * Dev-only: creates a demo session so screens can be opened and screenshotted without API keys. Runs inside the
 * worker container (ffmpeg, DATA_DIR=/data):
 *
 *   docker compose exec -w /app/apps/worker worker node --import tsx scripts/seed-demo.ts --stage ready
 *   docker compose exec -w /app/apps/worker worker node --import tsx scripts/seed-demo.ts --stage awaiting_context
 *
 * - `ready`: a finished interview with one complete analysis version (3 topics, 12 moments across the three
 *   granularities with highlights, a grounded briefing, checks and thumbnails on the top highlights).
 * - `awaiting_context`: parked at the context-check pause with two open questions.
 *
 * Transcript, card and analysis are synthetic. There is no LangGraph checkpoint, so Continue/Skip on a seeded
 * session are ignored by the worker (the stage stays where the web moved it).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  formatTimestamp,
  topHighlights,
  type BriefingContent,
  type ContextCard,
  type HighlightTypeId,
  type MomentChecks,
  type Transcript,
  type Word,
} from "@digestor/core";
import {
  LocalStorage,
  completeAnalysisVersion,
  createDb,
  createSession,
  saveBriefing,
  saveContextCard,
  saveMoments,
  saveTopics,
  saveTranscript,
  setMomentChecks,
  setMomentThumb,
  setStage,
  startAnalysisVersion,
  updateSession,
  type NewMoment,
} from "@digestor/core/server";
import { ANALYSIS_MODELS, PROMPT_VERSIONS } from "../src/pipeline/analysis.js";

const stageArg = process.argv[process.argv.indexOf("--stage") + 1];
if (stageArg !== "awaiting_context" && stageArg !== "ready") {
  console.error("Usage: seed-demo.ts --stage ready|awaiting_context");
  process.exit(1);
}
const stage: "awaiting_context" | "ready" = stageArg;

const WORD_MS = 400; // 350 ms word + 50 ms gap
const SENTENCE_GAP_MS = 600;

type Line = { speaker: string; text: string };

/** Synthetic interview: three topics, each a run of host questions (A) and guest answers (B). */
const TOPIC_SCRIPTS: { title: string; summary: string; lines: Line[] }[] = [
  {
    title: "Housing costs",
    summary: "Why rents rose so fast and what the city plans to build.",
    lines: [
      { speaker: "A", text: "Rents in the city rose eighteen percent last year, why did that happen?" },
      { speaker: "B", text: "We simply did not build enough homes for ten years." },
      { speaker: "B", text: "Every council before us promised new housing and delivered very little." },
      { speaker: "B", text: "Demand kept growing while supply stayed almost flat." },
      { speaker: "B", text: "That is the whole story, and it is not complicated." },
      { speaker: "A", text: "So what will you do differently this time?" },
      { speaker: "B", text: "We will approve twelve thousand homes before the end of next year." },
      { speaker: "B", text: "A third of them will be social housing owned by the city." },
      { speaker: "B", text: "The permits are ready and the land is already ours." },
      { speaker: "A", text: "Critics say twelve thousand is a number you cannot reach." },
      { speaker: "B", text: "Critics said the same about the metro line and it opened on time." },
      { speaker: "B", text: "I would rather aim high and be judged on it." },
      { speaker: "A", text: "Will rents actually fall, or only rise more slowly?" },
      { speaker: "B", text: "I will not promise that rents fall next year." },
      { speaker: "B", text: "What I promise is that families stop leaving the city." },
    ],
  },
  {
    title: "Public transport",
    summary: "The new tram line, fares and the delays on the northern route.",
    lines: [
      { speaker: "A", text: "Let us talk about the northern tram line, which is two years late." },
      { speaker: "B", text: "The delay is real and I apologise to everyone who waited." },
      { speaker: "B", text: "We found old water pipes that no map showed." },
      { speaker: "B", text: "Moving them safely took fourteen months on its own." },
      { speaker: "A", text: "Your opponent says the budget doubled because of bad planning." },
      { speaker: "B", text: "My opponent voted for that budget twice." },
      { speaker: "B", text: "He can read his own votes before he gives interviews." },
      { speaker: "A", text: "Will fares go up when the line opens?" },
      { speaker: "B", text: "Fares stay frozen for students and pensioners." },
      { speaker: "B", text: "For everyone else the decision comes with next year's budget." },
      { speaker: "A", text: "That sounds like a yes." },
      { speaker: "B", text: "It sounds like a decision we have not taken yet." },
      { speaker: "B", text: "I quoted the transport minister last week and I stand by it." },
      { speaker: "B", text: "She said that cheap transport is the best climate policy we have." },
      { speaker: "B", text: "I agree with her completely on that point." },
    ],
  },
  {
    title: "City budget",
    summary: "Debt, the cuts to culture and the plan for next year's budget.",
    lines: [
      { speaker: "A", text: "The city debt grew by four hundred million under your mandate." },
      { speaker: "B", text: "It grew because we invested in schools and transport." },
      { speaker: "B", text: "Debt for a tram is not the same as debt for a party." },
      { speaker: "A", text: "Yet you cut the culture budget by fifteen percent." },
      { speaker: "B", text: "That cut was painful and I did not enjoy it." },
      { speaker: "B", text: "My own mother ran a small theatre for thirty years." },
      { speaker: "B", text: "I know exactly what those cuts mean for people." },
      { speaker: "A", text: "Will you restore the culture budget next year?" },
      { speaker: "B", text: "We will restore half of it in the next budget." },
      { speaker: "B", text: "The other half depends on the national transfer." },
      { speaker: "A", text: "And if the transfer does not come?" },
      { speaker: "B", text: "Then I will come back here and explain why." },
      { speaker: "B", text: "That is what accountability looks like." },
      { speaker: "A", text: "Thank you for your time today." },
      { speaker: "B", text: "Thank you for having me, it was a pleasure." },
    ],
  },
];

type Sentence = Line & { startMs: number; endMs: number; topic: number };

function timeline(lines: (Line & { topic: number })[]): { sentences: Sentence[]; words: Word[]; durationMs: number } {
  const sentences: Sentence[] = [];
  const words: Word[] = [];
  let t = 0;
  for (const line of lines) {
    const tokens = line.text.split(" ");
    const startMs = t;
    tokens.forEach((text, i) => {
      const w0 = startMs + i * WORD_MS;
      words.push({ text, startMs: w0, endMs: w0 + 350, speaker: line.speaker, confidence: 0.95 });
    });
    const endMs = startMs + (tokens.length - 1) * WORD_MS + 350;
    sentences.push({ ...line, startMs, endMs });
    t = endMs + SENTENCE_GAP_MS;
  }
  return { sentences, words, durationMs: t };
}

/** The ready demo repeats each topic's script so the session is long enough for real exchanges (≈ 11 min). */
const REPEATS = 3;
function readyLines(): (Line & { topic: number })[] {
  return TOPIC_SCRIPTS.flatMap((s, topic) => Array.from({ length: REPEATS }, () => s.lines.map((l) => ({ ...l, topic }))).flat());
}

/** The context-check demo: neutral numbered sentences, as before. */
function contextLines(): (Line & { topic: number })[] {
  return Array.from({ length: 60 }, (_, s) => ({
    speaker: s % 3 === 2 ? "B" : "A",
    text: `${Array.from({ length: 9 }, (_, w) => `word${w}`).join(" ")} point${s}.`,
    topic: 0,
  }));
}

const fact = (value: string | null, source: "video" | "metadata" | "human" | null, evidence: string | null) => ({
  value,
  source,
  evidence,
});

function buildCard(needsAnswers: boolean, sampleStartMs: number): ContextCard {
  return {
    language: fact("en", "video", "detected from audio"),
    profile: { value: "interview", confidence: needsAnswers ? 0.5 : 0.9, evidence: "one host asks, one guest answers" },
    title: fact("Demo interview", "metadata", "seeded title"),
    summary: "A synthetic interview with the mayor about housing, transport and the city budget.",
    setting: fact(needsAnswers ? null : "City radio studio", needsAnswers ? null : "metadata", needsAnswers ? null : "seeded"),
    dateOrYear: fact(needsAnswers ? null : "2026", needsAnswers ? null : "metadata", needsAnswers ? null : "seeded"),
    participants: [
      { speakerId: "A", name: fact("Alex Host", "metadata", "Alex Host"), role: fact("host", "video", "host"), affiliation: fact(null, null, null) },
      {
        speakerId: "B",
        name: fact(needsAnswers ? null : "Sam Guest", needsAnswers ? null : "metadata", needsAnswers ? null : "Sam Guest"),
        role: fact(needsAnswers ? null : "mayor", needsAnswers ? null : "video", needsAnswers ? null : "mayor"),
        affiliation: fact(null, null, null),
      },
    ],
    sufficient: !needsAnswers,
    openQuestions: needsAnswers
      ? [
          { id: "participant:B", target: "participant", speakerId: "B", question: "Who is speaker B?", why: "Their name is never said.", sampleStartMs },
          { id: "date", target: "date", speakerId: null, question: "When was this recorded?", why: "No date in the video or metadata.", sampleStartMs: null },
        ]
      : [],
  };
}

/** One moment from sentence `from` to sentence `to` (inclusive), always on sentence boundaries. */
function span(sentences: Sentence[], from: number, to: number) {
  return { startMs: sentences[from]!.startMs, endMs: sentences[to]!.endMs };
}

type Spec = {
  granularity: NewMoment["granularity"];
  from: number; // line index from the topic's first line (may run into the script's repetition)
  to: number; // inclusive
  title: string;
  why: string;
  relevance: number;
  types: HighlightTypeId[];
  parent?: number; // index into the specs of the same topic
};

/**
 * Per topic: an exchange (≈ 2 min), two passages inside it (≈ 30 s) and a punchline (≈ 10–15 s): 12 moments, all
 * inside their granularity's accepted range.
 */
const MOMENT_SPECS: Spec[][] = [
  [
    { granularity: "exchange", from: 0, to: 29, title: "Why rents rose, and the 12,000-home promise", why: "The mayor's full answer on housing, from the cause to the promise.", relevance: 88, types: ["key_point"] },
    { granularity: "passage", from: 5, to: 11, title: "Twelve thousand homes by next year", why: "A concrete, checkable promise with a deadline.", relevance: 92, types: ["news_line"], parent: 0 },
    { granularity: "passage", from: 8, to: 14, title: "No promise that rents will fall", why: "Pressed on rents, the mayor declines to say they will fall.", relevance: 80, types: ["dodge"], parent: 0 },
    { granularity: "punchline", from: 9, to: 11, title: "\"Critics said the same about the metro line\"", why: "A short, quotable comeback to the critics.", relevance: 85, types: ["quotable"], parent: 0 },
  ],
  [
    { granularity: "exchange", from: 0, to: 26, title: "The two-year tram delay and fares", why: "Apology, explanation and a fare answer that stays open.", relevance: 84, types: ["key_point"] },
    { granularity: "passage", from: 4, to: 9, title: "\"My opponent voted for that budget twice\"", why: "The sharpest clash of the interview.", relevance: 90, types: ["heated"], parent: 0 },
    { granularity: "passage", from: 7, to: 12, title: "Fares: frozen for some, undecided for others", why: "The host presses and the mayor avoids a yes or no.", relevance: 78, types: ["dodge"], parent: 0 },
    { granularity: "punchline", from: 9, to: 11, title: "\"That sounds like a yes\"", why: "A light exchange that lands well.", relevance: 70, types: ["light"], parent: 0 },
  ],
  [
    { granularity: "exchange", from: 0, to: 27, title: "Debt, culture cuts and next year's budget", why: "The mayor defends the debt and commits to restoring half the culture budget.", relevance: 86, types: ["key_point"] },
    { granularity: "passage", from: 3, to: 8, title: "\"My own mother ran a small theatre\"", why: "A personal moment behind a painful cut.", relevance: 82, types: ["emotional"], parent: 0 },
    { granularity: "passage", from: 7, to: 12, title: "Half the culture budget restored", why: "A clear commitment for next year's budget.", relevance: 87, types: ["news_line"], parent: 0 },
    { granularity: "punchline", from: 0, to: 2, title: "\"Debt for a tram is not debt for a party\"", why: "A compact line likely to be quoted.", relevance: 83, types: ["quotable"], parent: 0 },
  ],
];

const CHECK_VARIANTS = (continuesWith: string | null): MomentChecks[] => [
  { argumentComplete: false, continuesWith, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false },
  { argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: "Answers a criticism raised earlier; the critic is not named here.", reportedSpeech: false, interpreter: false },
  { argumentComplete: true, continuesWith: null, unansweredQuestion: true, contextRisk: null, reportedSpeech: false, interpreter: false },
  { argumentComplete: true, continuesWith: null, unansweredQuestion: false, contextRisk: null, reportedSpeech: false, interpreter: false },
];

const { db, close } = createDb(process.env.DATABASE_URL!);
const storage = new LocalStorage(process.env.DATA_DIR ?? "/data");
const id = randomUUID();
const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);

try {
  const { sentences, words, durationMs } = timeline(stage === "ready" ? readyLines() : contextLines());
  const transcript: Transcript = { language: "en", languageConfidence: 0.98, durationMs, words };
  const dir = storage.resolve(id);
  mkdirSync(`${dir}/thumbs`, { recursive: true });
  ff([
    "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=330",
    "-t", String(durationMs / 1000), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", `${dir}/original.mp4`,
  ]);
  ff(["-i", `${dir}/original.mp4`, "-c", "copy", `${dir}/proxy.mp4`]);

  const title = stage === "ready" ? "Mayor interview (seeded)" : "Demo interview (seeded)";
  await createSession(db, { id, title, source: "upload", originalKey: `${id}/original.mp4` });
  await updateSession(db, id, { proxyKey: `${id}/proxy.mp4`, durationMs, language: "en", profile: "interview" });
  await saveTranscript(db, id, transcript);
  await saveContextCard(db, id, buildCard(stage === "awaiting_context", sentences[2]!.startMs), 1);

  if (stage === "awaiting_context") {
    await setStage(db, id, stage, 55);
  } else {
    await seedAnalysis(sentences);
    await setStage(db, id, "ready", 100);
  }
  console.log(`seeded ${stage}: http://localhost:3000/s/${id}`);
} finally {
  await close();
}

async function seedAnalysis(sentences: Sentence[]): Promise<void> {
  const linesPerTopic = TOPIC_SCRIPTS.map((s) => s.lines.length * REPEATS);
  const topicStart = (t: number) => linesPerTopic.slice(0, t).reduce((a, b) => a + b, 0);
  const version = await startAnalysisVersion(db, id, {
    profile: "interview",
    reason: "initial",
    models: { ...ANALYSIS_MODELS },
    promptVersions: { ...PROMPT_VERSIONS },
  });
  const topics = await saveTopics(
    db,
    version.id,
    TOPIC_SCRIPTS.map((s, idx) => {
      const first = topicStart(idx);
      const next = topicStart(idx + 1);
      return {
        idx,
        title: s.title,
        summary: s.summary,
        startMs: idx === 0 ? 0 : sentences[first]!.startMs,
        endMs: next < sentences.length ? sentences[next]!.startMs : sentences.at(-1)!.endMs + SENTENCE_GAP_MS,
      };
    }),
  );

  const rows: NewMoment[] = [];
  MOMENT_SPECS.forEach((specs, t) => {
    const base = rows.length;
    const offset = topicStart(t);
    for (const m of specs) {
      const range = span(sentences, offset + m.from, offset + m.to);
      const speakers = [...new Set(sentences.slice(offset + m.from, offset + m.to + 1).map((s) => s.speaker))].sort();
      rows.push({
        topicId: topics[t]!.id,
        granularity: m.granularity,
        ...range,
        title: m.title,
        why: m.why,
        relevance: m.relevance,
        speakers,
        evidence: [sentences[offset + m.from]!.text],
        origin: "ai",
        highlights: m.types.map((type) => ({ type, method: "ai" as const, value: null })),
        ...(m.parent !== undefined ? { insideIdx: base + m.parent } : {}),
      });
    }
  });
  const saved = await saveMoments(db, version.id, rows);

  // Briefing: every sentence cites seeded moments; key quotes are exact transcript sentences of their moment.
  const byTopic = (t: number) => saved.filter((m) => m.topicId === topics[t]!.id);
  const quote = (t: number, specIdx: number) => {
    const m = byTopic(t)[specIdx]!;
    const s = sentences.find((x) => x.startMs === m.startMs)!;
    return { momentId: m.id, text: s.text };
  };
  const briefing: BriefingContent = {
    lead: [
      { text: "The mayor promised twelve thousand new homes by the end of next year, a third of them social housing.", momentIds: [byTopic(0)[1]!.id] },
      { text: "He apologised for the two-year tram delay and clashed with his opponent over its budget.", momentIds: [byTopic(1)[0]!.id, byTopic(1)[1]!.id] },
      { text: "Half of the culture budget cut will be restored next year.", momentIds: [byTopic(2)[2]!.id] },
    ],
    sections: topics.map((topic, t) => ({
      topicId: topic.id,
      summary: [
        { text: TOPIC_SCRIPTS[t]!.summary, momentIds: [byTopic(t)[0]!.id] },
        { text: MOMENT_SPECS[t]![1]!.why, momentIds: [byTopic(t)[1]!.id] },
      ],
      keyQuote: quote(t, 3),
    })),
  };
  await saveBriefing(db, version.id, briefing);

  // Checks and thumbnails on the top highlights, as the pipeline does.
  const withHighlights = saved.map((m, i) => ({ ...m, highlights: rows[i]!.highlights }));
  const top = [...new Set(topHighlights(withHighlights, "interview").map((h) => h.moment))];
  for (const [i, m] of top.entries()) {
    const next = sentences.find((s) => s.startMs >= m.endMs);
    await setMomentChecks(db, m.id, CHECK_VARIANTS(next?.text ?? null)[Math.min(i, 3)]!);
    const key = storage.key(id, `thumbs/${m.id}.jpg`);
    ff(["-ss", (Math.round((m.startMs + m.endMs) / 2) / 1000).toFixed(3), "-i", storage.resolve(`${id}/proxy.mp4`), "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", storage.resolve(key)]);
    await setMomentThumb(db, m.id, key);
  }
  await completeAnalysisVersion(db, version.id);
  console.log(`analysis v${version.version}: ${topics.length} topics, ${saved.length} moments, ${top.length} checked (${formatTimestamp(sentences.at(-1)!.endMs)})`);
  for (const m of saved) console.log(`  ${m.granularity.padEnd(9)} ${formatTimestamp(m.startMs)} ${Math.round((m.endMs - m.startMs) / 1000)} s  ${m.title}`);
}
