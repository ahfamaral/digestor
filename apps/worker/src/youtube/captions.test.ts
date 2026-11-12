import { describe, expect, it } from "vitest";
import { blocked, captionArgs } from "./captions.js";
import { mapYtDlpError } from "./ytdlp.js";

// Recorded 2026-11-12 on the server (yt-dlp 2026.10.26, rotated cookies): exit 0, no .vtt written.
const ROTATED = `WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser as a security measure.
WARNING: [youtube] Sign in to confirm you’re not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.
WARNING: No video formats found!
WARNING: Requested format is not available
[info] There are no subtitles for the requested languages`;

describe("captions", () => {
  it("tells a YouTube block from a video that simply has no captions", () => {
    expect(blocked(ROTATED)).toBe(true);
    expect(mapYtDlpError(ROTATED)).toBe("YouTube blocked this download from the server. Download the video yourself and upload the file instead.");
    expect(blocked("[info] There are no subtitles for the requested languages")).toBe(false);
  });

  it("asks for the Portuguese automatic captions only, never the video", () => {
    const args = captionArgs("NmI46Y25mEU", "/tmp/x/v", "/tmp/x/v.cookies.txt");
    expect(args).toEqual(expect.arrayContaining(["--skip-download", "--ignore-no-formats-error", "--write-auto-subs", "pt-orig", "--cookies", "/tmp/x/v.cookies.txt"]));
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=NmI46Y25mEU");
    expect(captionArgs("NmI46Y25mEU", "/tmp/x/v")).not.toContain("--cookies");
  });
});
