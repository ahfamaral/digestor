import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alignSpeeches, alignWithoutStart, captionWords, secondsBetween, type VideoSpeech } from "./videoAlign.js";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/camara-video/${name}`, import.meta.url), "utf8");
const vtt = fixture("NmI46Y25mEU-first16min.pt-orig.vtt");
const speeches = JSON.parse(fixture("speeches-2026-06-30.json")) as (VideoSpeech & { name: string })[];
const STREAM_START = "2026-06-30 14:24:31";
const byName = (name: string) => speeches.find((s) => s.name === name)!;

describe("captionWords", () => {
  it("reads each new word once, with its own time", () => {
    const words = captionWords(vtt);
    expect(words.slice(0, 6)).toEqual([
      { t: 18.439, w: "boa" }, { t: 18.68, w: "tarde" }, { t: 18.92, w: "a" }, { t: 19.119, w: "todos" }, { t: 19.52, w: "a" }, { t: 19.6, w: "lista" },
    ]);
    // the 10 ms cues only repeat the previous line: "registra" appears once
    expect(words.filter((x) => x.w === "registra" && x.t < 30)).toHaveLength(1);
    expect(words.every((x, i) => i === 0 || x.t >= words[i - 1]!.t)).toBe(true);
  });

  it("ignores headers, blank cues and CRLF line ends", () => {
    expect(captionWords("WEBVTT\r\nKind: captions\r\n\r\n00:00:01.000 --> 00:00:02.000 align:start\r\n \r\nOlá<00:00:01.500><c> mundo</c>\r\n")).toEqual([
      { t: 1, w: "ola" }, { t: 1.5, w: "mundo" },
    ]);
    expect(captionWords("WEBVTT\n\n00:00:01.000 --> 00:00:01.010\nrepetido\n")).toEqual([]);
  });
});

describe("alignSpeeches", () => {
  const matches = alignSpeeches(captionWords(vtt), STREAM_START, 20736, speeches);
  const at = (name: string) => matches.find((m) => m.speechKey === byName(name).speechKey);

  it("places each spoken speech within seconds of where the deputy starts and stops", () => {
    // checked by hand on the video: Pastor Henrique Vieira starts "Quero falar hoje sobre o bispo…" at 1:18 and ends
    // "…fraterno abraço" at 6:54; Otoni de Paula follows; Luiz Lima's speech starts at about 9:35.
    expect(at("Pastor Henrique Vieira")).toMatchObject({ startS: expect.closeTo(76, 0), score: expect.any(Number) });
    expect(at("Pastor Henrique Vieira")!.endS).toBeGreaterThanOrEqual(413);
    expect(at("Pastor Henrique Vieira")!.endS).toBeLessThanOrEqual(420);
    expect(at("Pastor Henrique Vieira")!.score).toBeGreaterThan(0.9);
    const otoni = at("Otoni de Paula")!;
    expect(otoni.startS).toBeGreaterThan(at("Pastor Henrique Vieira")!.endS - 5);
    expect(otoni.score).toBeGreaterThan(0.8);
    expect(at("Luiz Lima")!.startS).toBeGreaterThan(otoni.endS - 5);
  });

  it("skips a speech sent in writing", () => {
    expect(at("Capitão Alberto Neto")).toBeUndefined();
    expect(matches).toHaveLength(3);
  });

  it("drops a speech the captions don't contain, and one stamped outside the video", () => {
    const made: VideoSpeech = {
      speechKey: "x", startsAt: "2026-06-30 14:28:00",
      text: "O SR. FULANO (PL - RS.) - Senhor Presidente, hoje falo sobre ferrovias, portos, aeroportos, hidrovias, rodovias, logística, exportação, armazenagem e frete.",
    };
    expect(alignSpeeches(captionWords(vtt), STREAM_START, 20736, [made])).toEqual([]);
    const late = { ...byName("Pastor Henrique Vieira"), startsAt: "2026-07-01 10:00:00" };
    expect(alignSpeeches(captionWords(vtt), STREAM_START, 20736, [late])).toEqual([]);
  });

  it("a video with no known start: measures the start from the captions, then places the speeches", () => {
    // anchored 66 minutes too late (a video uploaded after the session carries the upload time, not the stream start)
    const r = alignWithoutStart(captionWords(vtt), "2026-06-30 15:30:00", 20736, speeches);
    expect(Math.abs(secondsBetween("2026-06-30 14:24:31", r.streamStart))).toBeLessThan(5 * 60);
    expect(r.matches.map((m) => m.speechKey).sort()).toEqual(matches.map((m) => m.speechKey).sort());
    expect(r.matches.find((m) => m.speechKey === byName("Pastor Henrique Vieira").speechKey)!.startS).toBeCloseTo(76, -1);
  });

  it("secondsBetween reads local timestamps with or without seconds", () => {
    expect(secondsBetween("2026-06-30 14:24:31", "2026-06-30 14:28:00")).toBe(209);
    expect(secondsBetween("2026-06-30 14:24:31", "2026-06-30T14:24")).toBe(-31);
  });
});
