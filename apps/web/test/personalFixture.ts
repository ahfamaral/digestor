import type { Word } from "@digestor/core";
import {
  completeAnalysisVersion, createSession, saveMoments, saveTranscript, startAnalysisVersion, updateSession, type Db,
} from "@digestor/core/server";

/** 100 one-second words; every tenth word ends a sentence (word 9 ends at 9900 ms, word 19 at 19900 ms…). */
export const WORDS: Word[] = Array.from({ length: 100 }, (_, i) => ({
  text: i % 10 === 9 ? `w${i}.` : `w${i}`,
  startMs: i * 1000,
  endMs: i * 1000 + 900,
  speaker: "A",
  confidence: 0.9,
}));

/** A `ready` session with a transcript and one complete analysis holding one moment per `[startMs, endMs]` range. */
export async function seedReadySession(db: Db, ranges: [number, number, string?][] = [[10_000, 30_000]]) {
  const s = await createSession(db, { title: "Talk", source: "upload" });
  await updateSession(db, s.id, { stage: "ready", progress: 100, profile: "interview", language: "en", durationMs: 100_000 });
  await saveTranscript(db, s.id, { language: "en", languageConfidence: 1, durationMs: 100_000, words: WORDS });
  const v = await startAnalysisVersion(db, s.id, { profile: "interview", reason: "test", models: {}, promptVersions: {} });
  const moments = await saveMoments(
    db,
    v.id,
    ranges.map(([startMs, endMs, title], i) => ({
      topicId: null, granularity: "passage" as const, startMs, endMs, title: title ?? `Moment ${i + 1}`, why: "Why: test",
      relevance: 50, speakers: [], evidence: [], origin: "ai" as const, highlights: [],
    })),
  );
  await completeAnalysisVersion(db, v.id);
  return { sessionId: s.id, analysisId: v.id, moments };
}
