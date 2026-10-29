import { AssemblyAITranscriber } from "../src/transcribe/assemblyai.js";

const file = process.argv[2];
const key = process.env.ASSEMBLYAI_API_KEY;
if (!file || !key) {
  console.error("Usage: ASSEMBLYAI_API_KEY=... tsx scripts/try-transcribe.ts <audio-or-video-file>");
  process.exit(1);
}
const t = await new AssemblyAITranscriber(key).transcribe(file);
console.log("language:", t.language, `(confidence ${t.languageConfidence})`);
console.log("duration ms:", t.durationMs);
console.log("speakers:", new Set(t.words.map((w) => w.speaker)).size, [...new Set(t.words.map((w) => w.speaker))]);
for (const w of t.words.slice(0, 10)) console.log(`${w.startMs}-${w.endMs} [${w.speaker}] ${w.text}`);
