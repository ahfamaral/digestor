import { describe, expect, it } from "vitest";
import { asciiName, zipEntries, type ZipClip } from "./zipNames";

const clip = (over: Partial<ZipClip> = {}): ZipClip => ({
  id: "c1", title: "Opening statement", mp4: true, audio: true,
  languages: [{ language: "pt", text: true, burned: false }], ...over,
});

describe("asciiName", () => {
  it("transliterates, strips separators and falls back", () => {
    expect(asciiName("Straße über Käse")).toBe("Strasse uber Kase");
    expect(asciiName("Declaração: não / sim")).toBe("Declaracao nao sim");
    expect(asciiName("Привет")).toBe("clip");
    expect(asciiName("../../etc/passwd")).toBe("etc passwd");
    expect(asciiName("")).toBe("clip");
    expect(asciiName("x".repeat(300)).length).toBeLessThanOrEqual(80);
  });
});

describe("zipEntries", () => {
  it("plain: only the videos, numbered", () => {
    const r = zipEntries([clip(), clip({ id: "c2", title: "Second" }), clip({ id: "c3", mp4: false })], "plain");
    expect(r.entries.map((e) => e.name)).toEqual(["01 Opening statement.mp4", "02 Second.mp4"]);
    expect(r.skipped).toEqual([]);
  });
  it("audio: only each clip's .m4a, numbered by the clip's position", () => {
    const r = zipEntries([clip(), clip({ id: "c2", audio: false }), clip({ id: "c3", title: "Third" })], "audio");
    expect(r.entries.map((e) => [e.name, e.kind, e.clipId])).toEqual([["01 Opening statement.m4a", "m4a", "c1"], ["03 Third.m4a", "m4a", "c3"]]);
  });
  it("files: video plus SRT and VTT per language with text", () => {
    const r = zipEntries([clip({ languages: [{ language: "pt", text: true, burned: false }, { language: "en", text: false, burned: false }] })], "files");
    expect(r.entries.map((e) => [e.name, e.kind, e.language])).toEqual([
      ["01 Opening statement.mp4", "mp4", undefined],
      ["01 Opening statement.pt.srt", "srt", "pt"],
      ["01 Opening statement.pt.vtt", "vtt", "pt"],
    ]);
  });
  it("burned: one file per burned language; clips with none are skipped", () => {
    const r = zipEntries(
      [
        clip({ languages: [{ language: "pt", text: true, burned: true }, { language: "en", text: true, burned: true }] }),
        clip({ id: "c2", title: "No burn" }),
      ],
      "burned",
    );
    expect(r.entries.map((e) => [e.name, e.kind])).toEqual([
      ["01 Opening statement.pt.mp4", "burned"],
      ["01 Opening statement.en.mp4", "burned"],
    ]);
    expect(r.skipped).toEqual([{ n: 2, title: "No burn" }]);
  });
  it("names stay unique and ASCII; an untitled clip is 'clip'", () => {
    const r = zipEntries([clip({ title: "Привет" }), clip({ id: "c2", title: "" })], "plain");
    expect(r.entries.map((e) => e.name)).toEqual(["01 clip.mp4", "02 clip.mp4"]);
    const dup = zipEntries([clip({ languages: [{ language: "pt", text: true, burned: true }, { language: "pt", text: true, burned: true }] })], "burned");
    expect(new Set(dup.entries.map((e) => e.name.toLowerCase())).size).toBe(dup.entries.length);
  });
});
