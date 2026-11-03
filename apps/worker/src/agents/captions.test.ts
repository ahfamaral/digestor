import { describe, expect, it } from "vitest";
import type { Word } from "@digestor/core";
import { FakeLLM } from "../llm/structured.js";
import {
  CAPTION_MAX_FRAMES,
  CAPTION_MIN_TURN_MS,
  captionFramePlan,
  captionVotes,
  titleCaseName,
  readCaption,
} from "./captions.js";

/** One word per second from `startMs`, a turn of `seconds` seconds. */
function turn(speaker: string, startMs: number, seconds: number): Word[] {
  return Array.from({ length: seconds }, (_, i) => ({
    text: "w", startMs: startMs + i * 1000, endMs: startMs + i * 1000 + 900, speaker, confidence: 0.9,
  }));
}

describe("captionFramePlan", () => {
  it("captionFramePlan takes up to 3 long turns per voice, frames at +1 s and +4 s, longest voices first, 60 at most", () => {
    const words = [
      ...turn("A", 0, 10), // long
      ...turn("B", 15_000, 20), // long
      ...turn("A", 36_000, 1),
      ...turn("B", 37_500, 3), // too short
      ...turn("A", 40_000, 9), // long
      ...turn("B", 50_000, 5),
      ...turn("A", 60_000, 9), // long (3rd of A)
      ...turn("B", 70_000, 5),
      ...turn("A", 80_000, 30), // 4th long turn of A: not used (first turns preferred)
    ];
    expect(CAPTION_MIN_TURN_MS).toBe(8_000);
    const plan = captionFramePlan(words);
    // A speaks 58 s in total, B 35 s: A first.
    expect(plan.filter((p) => p.speakerId === "A").map((p) => p.atMs)).toEqual([1_000, 4_000, 41_000, 44_000, 61_000, 64_000]);
    expect(plan.filter((p) => p.speakerId === "B").map((p) => p.atMs)).toEqual([16_000, 19_000]);
    expect(plan.map((p) => p.speakerId)).toEqual(["A", "A", "A", "A", "A", "A", "B", "B"]);
  });

  it("caps the plan at 60 frames", () => {
    const words: Word[] = [];
    for (let t = 0; t < 3; t++) for (let v = 0; v < 15; v++) words.push(...turn(`S${v}`, (t * 15 + v) * 20_000, 10));
    expect(captionFramePlan(words)).toHaveLength(CAPTION_MAX_FRAMES);
  });

  it("is empty when nobody speaks for 8 s in a row", () => {
    expect(captionFramePlan(turn("A", 0, 5))).toEqual([]);
  });
});

const read = (speakerId: string, atMs: number, name: string | null) => ({ speakerId, atMs, frameKey: `s/names/${speakerId}-${atMs}.jpg`, name, text: name });

describe("captionVotes", () => {
  it("captionVotes needs the same name in 2 frames of a voice and no other name", () => {
    expect(captionVotes([read("A", 1000, "Flávio Bolsonaro"), read("A", 4000, null)])).toEqual([]); // 1 frame
    const two = captionVotes([read("A", 1000, "Flávio Bolsonaro"), read("A", 4000, "FLAVIO BOLSONARO"), read("A", 9000, null)]);
    expect(two).toEqual([
      { speakerId: "A", name: "Flávio Bolsonaro", frameKey: "s/names/A-1000.jpg", text: "Flávio Bolsonaro", atMs: 1000, agreeing: 2, total: 3 },
    ]);
    // two agree, a third frame reads someone else: none
    expect(captionVotes([read("A", 1000, "Lula"), read("A", 4000, "Lula"), read("A", 9000, "César Tralli")])).toEqual([]);
    // voices are independent
    const both = captionVotes([read("A", 1000, "Lula"), read("A", 4000, "Lula"), read("B", 1000, "Tralli"), read("B", 4000, "Tralli")]);
    expect(both.map((v) => v.speakerId)).toEqual(["A", "B"]);
  });
});

const IMG = { mediaType: "image/jpeg" as const, data: "AAAA" };

describe("readCaption", () => {
  it("readCaption treats empty strings as none and keeps the prompt's rule", async () => {
    const llm = new FakeLLM({ byName: { captions: [{ captionText: "", personName: "", partyOrRole: "" }, { captionText: "FLÁVIO", personName: " Flávio ", partyOrRole: "PL" }] } });
    expect(await readCaption(llm, IMG)).toEqual({ text: null, name: null, partyOrRole: null });
    expect(await readCaption(llm, IMG)).toEqual({ text: "FLÁVIO", name: "Flávio", partyOrRole: "PL" });
    expect(llm.calls[0]!.system).toContain("Read only text visible in the image; never guess.");
    expect(llm.calls[0]!.system).toContain("several names");
    expect(llm.calls[0]).toMatchObject({ name: "captions", model: "fast", images: 1 });
  });
});

describe("titleCaseName", () => {
  it("gives an all-capitals name normal capitalisation, keeps particles lower and leaves mixed case alone", () => {
    expect(titleCaseName("FLÁVIO BOLSONARO")).toBe("Flávio Bolsonaro");
    expect(titleCaseName("MARIA DA SILVA DOS SANTOS")).toBe("Maria da Silva dos Santos");
    expect(titleCaseName("JEAN-LUC D'ÁVILA")).toBe("Jean-Luc D'Ávila");
    expect(titleCaseName("Flávio Bolsonaro")).toBe("Flávio Bolsonaro");
    expect(titleCaseName("Lula da Silva")).toBe("Lula da Silva");
  });
});

describe("captionVotes across voices", () => {
  it("drops a name that would win two or more voices (a timer showing both candidates)", () => {
    const votes = captionVotes([
      read("A", 1000, "Lula"), read("A", 4000, "Lula"),
      read("B", 1000, "LULA"), read("B", 4000, "Lula"),
      read("C", 1000, "Tralli"), read("C", 4000, "Tralli"),
    ]);
    expect(votes.map((v) => v.speakerId)).toEqual(["C"]);
  });
});

describe("the prompt", () => {
  it("asks for normal capitalisation", async () => {
    const llm = new FakeLLM({ byName: { captions: [{ captionText: "", personName: "", partyOrRole: "" }] } });
    await readCaption(llm, IMG);
    expect(llm.calls[0]!.system).toContain("normal capitalisation");
  });
});
