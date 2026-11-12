import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegError, run } from "../media/ffmpeg.js";
import { withYouTubeCookies } from "./cookieJar.js";
import { mapYtDlpError, YouTubeDownloadError } from "./ytdlp.js";

/** What the caption job needs from a video's info JSON. */
export type CaptionInfo = { startEpochS: number | null; durationS: number | null; live: boolean; wasLive: boolean };
export type Captions = { vtt: string | null; info: CaptionInfo };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The stream's start (`timestamp`, else `release_timestamp`; recorded 2026-11-12 on a finished Câmara stream: both set,
 * 21 s apart, `live_status: "was_live"`), its length, whether it is still live or not started (no captions yet), and
 * whether it was streamed live: only then is `timestamp` the stream's start (a video uploaded after the session, seen on
 * 9 Jun 2026's plenary, has `live_status: "not_live"` and `timestamp` = the upload, 8 days later).
 */
export function captionInfo(info: unknown): CaptionInfo {
  const i = (info && typeof info === "object" ? info : {}) as Record<string, unknown>;
  return {
    startEpochS: num(i.timestamp) ?? num(i.release_timestamp),
    durationS: num(i.duration),
    live: i.is_live === true || i.live_status === "is_live" || i.live_status === "is_upcoming",
    wasLive: i.was_live === true || i.live_status === "was_live",
  };
}

/** yt-dlp's output says YouTube refused the request (bot check, or cookies it no longer accepts). */
export function blocked(output: string): boolean {
  return /Sign in to confirm|not a bot|cookies are no longer valid/i.test(output);
}

export function captionArgs(videoId: string, outPathNoExt: string, cookiesPath?: string): string[] {
  return [
    "--js-runtimes", "node",
    ...(cookiesPath ? ["--cookies", cookiesPath] : []),
    // Captions only: no video or audio is downloaded. Without --ignore-no-formats-error yt-dlp stops at "Requested
    // format is not available" before writing the captions (seen 2026-11-12).
    "--skip-download", "--ignore-no-formats-error",
    "--write-auto-subs", "--sub-langs", "pt-orig", "--sub-format", "vtt",
    "--write-info-json", "--no-playlist", "--no-progress",
    "-o", `${outPathNoExt}.%(ext)s`,
    "--",
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

/**
 * A video's automatic Portuguese captions (`pt-orig`, word-timed VTT, ~2.3 MB for a 6-hour session) and its info.
 * `vtt` is null when YouTube has none (yet). Uses the live cookie jar like downloads do. Everything is
 * written to a temporary folder that is removed before returning: nothing is kept but what the caller stores.
 * UNVERIFIED: a video without automatic captions is assumed to exit 0 and write no .vtt (yt-dlp warns "There are no
 * subtitles for the requested languages"); scripts/smoke.md lists it.
 */
export async function fetchCaptions(videoId: string, env: NodeJS.ProcessEnv = process.env): Promise<Captions> {
  const dir = await mkdtemp(join(tmpdir(), "captions-"));
  const base = join(dir, "v");
  try {
    // The live cookie jar (`cookieJar.ts`): yt-dlp keeps YouTube's refreshed cookies in it, one run at a time.
    const { output, withCookies } = await withYouTubeCookies(env, async (cookies) => {
      try {
        const r = await run("yt-dlp", captionArgs(videoId, base, cookies), { timeoutMs: 120_000 });
        return { output: `${r.stdout}\n${r.stderr}`, withCookies: cookies !== undefined };
      } catch (err) {
        const stderr = err instanceof FfmpegError ? err.stderrTail : String(err);
        if (cookies && blocked(stderr)) {
          console.warn("[youtube] blocked even with YTDLP_COOKIES_FILE: the cookies may have expired; export fresh ones (docs/deploy.md).");
        }
        throw new YouTubeDownloadError(mapYtDlpError(stderr), stderr);
      }
    });
    const vttPath = `${base}.pt-orig.vtt`;
    // Seen 2026-11-12 on the server: with rotated cookies yt-dlp warns "cookies are no longer valid" and "Sign in to
    // confirm you're not a bot", then exits 0 with "There are no subtitles for the requested languages". That is a
    // block, not a video without captions.
    if (!existsSync(vttPath) && blocked(output)) {
      console.warn(
        withCookies
          ? "[youtube] blocked even with YTDLP_COOKIES_FILE: the cookies may have expired; export fresh ones (docs/deploy.md)."
          : "[youtube] blocked by YouTube's bot check; set YTDLP_COOKIES_FILE (docs/deploy.md).",
      );
      throw new YouTubeDownloadError(mapYtDlpError(output), output.slice(-2000));
    }
    const info = existsSync(`${base}.info.json`) ? captionInfo(JSON.parse(await readFile(`${base}.info.json`, "utf8"))) : captionInfo(null);
    return { vtt: existsSync(vttPath) ? await readFile(vttPath, "utf8") : null, info };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
