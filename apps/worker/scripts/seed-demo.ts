/**
 * Dev-only: creates a demo session parked at the context-check pause, so that screen can be opened and
 * screenshotted without API keys. Runs inside the worker container (ffmpeg, DATA_DIR=/data):
 *
 *   docker compose exec -w /app/apps/worker worker node --import tsx scripts/seed-demo.ts --stage awaiting_context
 *
 * The transcript and context card are synthetic (other stages return with Plan 2, Task 8). There is no LangGraph checkpoint, so Continue/Skip
 * on a seeded session are ignored by the worker (the stage stays where the web moved it).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ContextCard, Transcript, Word } from "@digestor/core";
import {
  LocalStorage,
  createDb,
  createSession,
  saveContextCard,
  saveTranscript,
  setStage,
  updateSession,
} from "@digestor/core/server";

const stageArg = process.argv[process.argv.indexOf("--stage") + 1];
if (stageArg !== "awaiting_context") {
  console.error("Only --stage awaiting_context is supported until Plan 2, Task 8.");
  process.exit(1);
}
const stage = "awaiting_context";

const SENTENCE_MS = 4_000; // 10 words × 400 ms, then a 600 ms pause before the next sentence
const GAP_MS = 600;
const SENTENCES = 60; // ≈ 4.6 min
const durationMs = SENTENCES * (SENTENCE_MS + GAP_MS);

function sentenceStart(i: number): number {
  return i * (SENTENCE_MS + GAP_MS);
}

function buildTranscript(): Transcript {
  const words: Word[] = [];
  for (let s = 0; s < SENTENCES; s++) {
    const speaker = s % 3 === 2 ? "B" : "A";
    for (let w = 0; w < 10; w++) {
      const startMs = sentenceStart(s) + w * 400;
      words.push({ text: w === 9 ? `point${s}.` : `word${w}`, startMs, endMs: startMs + 350, speaker, confidence: 0.95 });
    }
  }
  return { language: "en", languageConfidence: 0.98, durationMs, words };
}

const fact = (value: string | null, source: "video" | "metadata" | "human" | null, evidence: string | null) => ({
  value,
  source,
  evidence,
});

function buildCard(): ContextCard {
  const needsAnswers = true;
  return {
    language: fact("en", "video", "detected from audio"),
    profile: { value: "interview", confidence: needsAnswers ? 0.5 : 0.9, evidence: "one host asks, one guest answers" },
    title: fact("Demo interview", "metadata", "seeded title"),
    summary: "A synthetic interview used to preview the Digestor screens.",
    setting: fact(null, null, null),
    dateOrYear: fact(needsAnswers ? null : "2026", needsAnswers ? null : "metadata", needsAnswers ? null : "seeded"),
    participants: [
      { speakerId: "A", name: fact("Alex Host", "metadata", "Alex Host"), role: fact("host", "video", "host"), affiliation: fact(null, null, null) },
      { speakerId: "B", name: fact(needsAnswers ? null : "Sam Guest", needsAnswers ? null : "metadata", needsAnswers ? null : "Sam Guest"), role: fact(null, null, null), affiliation: fact(null, null, null) },
    ],
    sufficient: !needsAnswers,
    openQuestions: needsAnswers
      ? [
          { id: "participant:B", target: "participant", speakerId: "B", question: "Who is speaker B?", why: "Their name is never said.", sampleStartMs: sentenceStart(2) },
          { id: "date", target: "date", speakerId: null, question: "When was this recorded?", why: "No date in the video or metadata.", sampleStartMs: null },
        ]
      : [],
  };
}

const { db, close } = createDb(process.env.DATABASE_URL!);
const storage = new LocalStorage(process.env.DATA_DIR ?? "/data");
const id = randomUUID();
const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);

try {
  const dir = storage.resolve(id);
  mkdirSync(`${dir}/thumbs`, { recursive: true });
  ff([
    "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=330",
    "-t", String(durationMs / 1000), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", `${dir}/original.mp4`,
  ]);
  ff(["-i", `${dir}/original.mp4`, "-c", "copy", `${dir}/proxy.mp4`]);

  await createSession(db, { id, title: "Demo interview (seeded)", source: "upload", originalKey: `${id}/original.mp4` });
  await updateSession(db, id, { proxyKey: `${id}/proxy.mp4`, durationMs, language: "en", profile: "interview" });
  await saveTranscript(db, id, buildTranscript());
  await saveContextCard(db, id, buildCard(), 1);
  await setStage(db, id, stage, 40);
  console.log(`seeded ${stage}: http://localhost:3000/s/${id}`);
} finally {
  await close();
}
