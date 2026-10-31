import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TranscriptSchema } from "@digestor/core";
import { FakeTranscriber, mapAssemblyAI, TranscriptionError, throwIfError } from "./assemblyai.js";

const raw = JSON.parse(
  readFileSync(new URL("../../test/fixtures/assemblyai-raw.json", import.meta.url), "utf8"),
);

describe("mapAssemblyAI", () => {
  it("maps language, duration in ms and speakers, and validates", () => {
    const t = mapAssemblyAI(raw);
    expect(() => TranscriptSchema.parse(t)).not.toThrow();
    expect(t.language).toBe("pt");
    expect(t.languageConfidence).toBeCloseTo(0.98);
    expect(t.durationMs).toBe(9000);
    expect(t.words).toHaveLength(15);
    expect(new Set(t.words.map((w) => w.speaker))).toEqual(new Set(["A", "B", "?"]));
    expect(t.words[0]).toMatchObject({ text: "Bom", startMs: 240, speaker: "A" });
  });

  it("uses '?' for missing speaker and 1 for missing language confidence", () => {
    const t = mapAssemblyAI({
      language_code: "en",
      audio_duration: 5,
      words: [{ text: "hi", start: 0, end: 500, confidence: 0.9, speaker: null }],
    });
    expect(t.words[0]!.speaker).toBe("?");
    expect(t.languageConfidence).toBe(1);
  });

  it("clamps words to [0, durationMs] and drops empty ones", () => {
    const t = mapAssemblyAI({
      language_code: "en",
      language_confidence: 0.9,
      audio_duration: 2,
      words: [
        { text: "a", start: -50, end: 500, confidence: 1, speaker: "A" },
        { text: "b", start: 1800, end: 2400, confidence: 1, speaker: "A" },
        { text: "gone", start: 2100, end: 2500, confidence: 1, speaker: "A" },
        { text: "zero", start: 1000, end: 1000, confidence: 1, speaker: "A" },
      ],
    });
    expect(t.words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
      ["a", 0, 500],
      ["b", 1800, 2000],
    ]);
  });

  it("falls back to the probed duration when AssemblyAI omits audio_duration", () => {
    const t = mapAssemblyAI(
      { language_code: "en", words: [{ text: "hi", start: 100, end: 500, confidence: 0.9, speaker: "A" }] },
      5000,
    );
    expect(t.durationMs).toBe(5000);
    expect(t.words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([["hi", 100, 500]]);
  });

  it("prefers AssemblyAI's audio_duration over the fallback", () => {
    expect(mapAssemblyAI({ language_code: "en", audio_duration: 2, words: [] }, 5000).durationMs).toBe(2000);
  });

  it("sorts words by startMs", () => {
    const t = mapAssemblyAI({
      language_code: "en",
      audio_duration: 5,
      words: [
        { text: "second", start: 1000, end: 1500, confidence: 1, speaker: "A" },
        { text: "first", start: 0, end: 500, confidence: 1, speaker: "A" },
      ],
    });
    expect(t.words.map((w) => w.text)).toEqual(["first", "second"]);
  });
});

describe("throwIfError", () => {
  it("logs the vendor's error text (only the logs see it; the user gets a fixed sentence)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => throwIfError({ status: "error", error: "Audio too short" })).toThrow(TranscriptionError);
    expect(spy.mock.calls.flat().map(String).join(" ")).toContain("Audio too short");
    spy.mockRestore();
  });
  it("throws TranscriptionError with the vendor message on error status", () => {
    expect(() => throwIfError({ status: "error", error: "Audio too short" })).toThrow(TranscriptionError);
    expect(() => throwIfError({ status: "error", error: "Audio too short" })).toThrow("Audio too short");
  });
  it("passes completed responses", () => {
    expect(() => throwIfError(raw)).not.toThrow();
  });
});

describe("FakeTranscriber", () => {
  it("returns the given transcript", async () => {
    const t = mapAssemblyAI(raw);
    expect(await new FakeTranscriber(t).transcribe("x.wav")).toBe(t);
  });
});

describe("mapAssemblyAI on a recorded response", () => {
  // Real response from the 2026-10-30 smoke run (speaker_labels + language_detection), trimmed to 300 words.
  const recorded = JSON.parse(
    readFileSync(new URL("../../test/fixtures/assemblyai/pt-debate.recorded.json", import.meta.url), "utf8"),
  );

  it("maps a real Portuguese debate transcript and validates", () => {
    expect(() => throwIfError(recorded)).not.toThrow();
    const t = mapAssemblyAI(recorded);
    expect(() => TranscriptSchema.parse(t)).not.toThrow();
    expect(t.language).toBe("pt");
    expect(t.durationMs).toBe(2_401_000);
    expect(t.words).toHaveLength(300);
    expect(t.words[0]).toMatchObject({ text: "feitas", startMs: 256, endMs: 673, speaker: "A" });
    expect(t.words.every((w) => /^[A-Z]$/.test(w.speaker))).toBe(true);
  });
});
