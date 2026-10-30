import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("../media/ffmpeg.js", async (orig) => ({ ...(await orig<typeof import("../media/ffmpeg.js")>()), run: runMock }));

import { FfmpegError } from "../media/ffmpeg.js";
import { downloadYouTube, mapInfoJson, mapYtDlpError, ytDlpArgs } from "./ytdlp.js";

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
    ["[download] File is larger than max-filesize (6000000000 bytes > 5368709120 bytes). Aborting.", /larger than the upload limit/],
    ["[download] x does not pass filter (!is_live), skipping ..", /Live streams can't be processed\. Try again after the stream has ended\./],
    ["something weird", /^Couldn't download this video from YouTube\.$/],
  ])("%s", (stderr, re) => {
    expect(mapYtDlpError(stderr)).toMatch(re);
  });
});

// Texts below were observed from yt-dlp 2026.10.26 in the worker container (2026-10-30): the filter rejection with
// --break-match-filters (exit 101, stdout) and the over-size skip (exit 0, stdout). A real live-stream URL was not
// available, so the live case uses the same "does not pass filter" wording with a hand-written filter name.
describe("downloadYouTube outcomes", () => {
  const out = () => path.join(os.tmpdir(), `ytdlp-test-${Math.random().toString(36).slice(2)}`);

  it("maps a filter rejection (exit 101, text on stdout only) to the live-stream sentence", async () => {
    runMock.mockRejectedValueOnce(new FfmpegError("yt-dlp", 101, "WARNING: no JS runtime"));
    await expect(downloadYouTube("https://youtu.be/x", out())).rejects.toThrow(/Live streams can't be processed/);
  });

  it("maps an over-size skip (exit 0, no video file) to the size sentence and removes the info json", async () => {
    const base = out();
    writeFileSync(`${base}.info.json`, "{}");
    runMock.mockResolvedValueOnce({
      stdout: "[download] File is larger than max-filesize (223779 bytes > 1024 bytes). Aborting.",
      stderr: "",
    });
    await expect(downloadYouTube("https://youtu.be/x", base)).rejects.toThrow(/larger than the upload limit/);
    expect(existsSync(`${base}.info.json`)).toBe(false);
  });

  it("gives the generic sentence, not a raw ENOENT, when yt-dlp produced nothing", async () => {
    runMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await expect(downloadYouTube("https://youtu.be/x", out())).rejects.toThrow(/^Couldn't download this video from YouTube\.$/);
  });
});

describe("ytDlpArgs", () => {
  it("ytdlp args include size cap and live filter", () => {
    const args = ytDlpArgs("https://youtu.be/x", "/tmp/out", { MAX_UPLOAD_GB: "2" });
    expect(args).toContain("--no-playlist");
    expect(args[args.indexOf("--max-filesize") + 1]).toBe("2G");
    expect(args[args.indexOf("--break-match-filters") + 1]).toBe("!is_live");
    expect(args.slice(-2)).toEqual(["--", "https://youtu.be/x"]);
  });
  it("defaults the cap to 5 GB and ignores bad values", () => {
    expect(ytDlpArgs("u", "/o", {})[ytDlpArgs("u", "/o", {}).indexOf("--max-filesize") + 1]).toBe("5G");
    const bad = ytDlpArgs("u", "/o", { MAX_UPLOAD_GB: "abc" });
    expect(bad[bad.indexOf("--max-filesize") + 1]).toBe("5G");
  });
});
