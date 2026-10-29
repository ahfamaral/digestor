import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapInfoJson, mapYtDlpError } from "./ytdlp.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/ytdlp-info.json", import.meta.url), "utf8"));

describe("mapInfoJson", () => {
  it("maps fields and formats the date", () => {
    expect(mapInfoJson(fixture)).toEqual({
      title: "Building a Small Garden Shed: Time-lapse",
      description: fixture.description,
      channel: "Example Workshop",
      uploadDate: "2026-03-14",
      webpageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      durationS: 187,
    });
  });
  it("truncates description to 4000 chars", () => {
    expect(mapInfoJson({ ...fixture, description: "x".repeat(5000) }).description).toHaveLength(4000);
  });
  it("tolerates missing fields", () => {
    const m = mapInfoJson({ title: "t" });
    expect(m).toMatchObject({ title: "t", description: "", channel: "", uploadDate: null, durationS: null });
  });
  it("falls back to uploader and null for bad dates", () => {
    const m = mapInfoJson({ title: "t", uploader: "U", upload_date: "garbage" });
    expect(m.channel).toBe("U");
    expect(m.uploadDate).toBeNull();
  });
});

describe("mapYtDlpError", () => {
  it.each([
    ["ERROR: [youtube] x: Sign in to confirm you're not a bot", /upload the file instead/],
    ["ERROR: Private video. Sign in if you've been granted access", /private/],
    ["ERROR: Sign in to confirm your age", /age-restricted/],
    ["This video is age-restricted", /age-restricted/],
    ["ERROR: Video unavailable", /unavailable or was removed/],
    ["something weird", /^Couldn't download this video from YouTube\.$/],
  ])("%s", (stderr, re) => {
    expect(mapYtDlpError(stderr)).toMatch(re);
  });
});
