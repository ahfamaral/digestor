import { describe, expect, it } from "vitest";
import { InvalidYouTubeUrlError, parseYouTubeUrl } from "./youtubeUrl.ts";

const ID = "dQw4w9WgXcQ";
const CANON = `https://www.youtube.com/watch?v=${ID}`;

describe("parseYouTubeUrl", () => {
  it.each([
    `https://youtu.be/${ID}?t=42`,
    `https://www.youtube.com/watch?v=${ID}&t=10s`,
    `http://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&list=PL123&index=2`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `  https://youtu.be/${ID}  `,
  ])("accepts %s", (u) => {
    expect(parseYouTubeUrl(u)).toEqual({ videoId: ID, url: CANON });
  });

  it.each([
    "https://www.youtube.com/playlist?list=PL123",
    "https://vimeo.com/123",
    "https://notyoutube.com/watch?v=" + ID,
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/",
    "not a url",
    "",
  ])("rejects %s", (u) => {
    expect(() => parseYouTubeUrl(u)).toThrow(InvalidYouTubeUrlError);
  });

  it("uses the specified message", () => {
    expect(() => parseYouTubeUrl("https://vimeo.com/1")).toThrow("Paste a link to a single YouTube video.");
  });
});
