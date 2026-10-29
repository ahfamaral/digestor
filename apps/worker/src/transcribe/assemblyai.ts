import { AssemblyAI } from "assemblyai";
import { TranscriptSchema, type Transcript, type Word } from "@digestor/core";

export interface Transcriber {
  transcribe(audioPath: string): Promise<Transcript>;
}

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

type RawWord = {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string | null;
};

export type RawTranscript = {
  status?: string;
  error?: string | null;
  language_code?: string | null;
  language_confidence?: number | null;
  audio_duration?: number | null;
  words?: RawWord[] | null;
};

export function throwIfError(raw: RawTranscript): void {
  if (raw.status === "error") {
    throw new TranscriptionError(raw.error ?? "Transcription failed.");
  }
}

export function mapAssemblyAI(raw: RawTranscript): Transcript {
  const durationMs = Math.round((raw.audio_duration ?? 0) * 1000);
  const words: Word[] = [];
  for (const w of raw.words ?? []) {
    const startMs = Math.min(Math.max(Math.round(w.start), 0), durationMs);
    const endMs = Math.min(Math.max(Math.round(w.end), 0), durationMs);
    if (endMs <= startMs) continue;
    words.push({
      text: w.text,
      startMs,
      endMs,
      speaker: w.speaker ?? "?",
      confidence: w.confidence,
    });
  }
  words.sort((a, b) => a.startMs - b.startMs);
  return TranscriptSchema.parse({
    language: raw.language_code ?? "und",
    languageConfidence: raw.language_confidence ?? 1,
    durationMs,
    words,
  });
}

export class AssemblyAITranscriber implements Transcriber {
  private client: AssemblyAI;

  constructor(apiKey: string) {
    this.client = new AssemblyAI({ apiKey });
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    const raw = await this.client.transcripts.transcribe({
      audio: audioPath,
      speaker_labels: true,
      language_detection: true,
      punctuate: true,
      format_text: true,
    });
    throwIfError(raw as RawTranscript);
    return mapAssemblyAI(raw as RawTranscript);
  }
}

export class FakeTranscriber implements Transcriber {
  constructor(private readonly transcript: Transcript) {}

  async transcribe(_audioPath: string): Promise<Transcript> {
    return this.transcript;
  }
}
