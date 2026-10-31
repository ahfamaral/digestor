import { existsSync } from "node:fs";
import { copyFile, readFile, rm } from "node:fs/promises";
import { FfmpegError, run } from "../media/ffmpeg.js";

export type YouTubeMetadata = {
  title: string;
  description: string;
  channel: string;
  uploadDate: string | null;
  webpageUrl: string;
  durationS: number | null;
};

export class YouTubeDownloadError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = "YouTubeDownloadError";
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function mapInfoJson(info: unknown): YouTubeMetadata {
  const i = (info && typeof info === "object" ? info : {}) as Record<string, unknown>;
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(str(i.upload_date));
  return {
    title: str(i.title),
    description: str(i.description).slice(0, 4000),
    channel: str(i.channel) || str(i.uploader),
    uploadDate: d ? `${d[1]}-${d[2]}-${d[3]}` : null,
    webpageUrl: str(i.webpage_url),
    durationS: typeof i.duration === "number" && Number.isFinite(i.duration) ? i.duration : null,
  };
}

const LIVE_MESSAGE = "Live streams can't be processed. Try again after the stream has ended.";

export function mapYtDlpError(stderr: string): string {
  if (!/confirm your age/i.test(stderr) && /Sign in to confirm|not a bot/i.test(stderr))
    return "YouTube blocked this download from the server. Download the video yourself and upload the file instead.";
  if (/Private video/i.test(stderr)) return "This video is private.";
  if (/confirm your age|age-restricted/i.test(stderr)) return "This video is age-restricted and can't be downloaded.";
  if (/File is larger than max-filesize/i.test(stderr)) return "This video is larger than the upload limit.";
  if (/does not pass filter|due to --break-match-filter/i.test(stderr))
    return LIVE_MESSAGE;
  if (/Video unavailable/i.test(stderr)) return "This video is unavailable or was removed.";
  return "Couldn't download this video from YouTube.";
}

/** MAX_UPLOAD_GB (default 5) also caps what yt-dlp may download. */
function maxFilesizeGb(env: NodeJS.ProcessEnv): number {
  const n = Number(env.MAX_UPLOAD_GB);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export function ytDlpArgs(url: string, outPathNoExt: string, env: NodeJS.ProcessEnv = process.env, cookiesPath?: string): string[] {
  return [
    // yt-dlp needs a JS runtime to solve YouTube's challenges; it only looks for deno unless told otherwise.
    "--js-runtimes", "node",
    ...(cookiesPath ? ["--cookies", cookiesPath] : []),
    "-f", "bv*[height<=1080]+ba/b[height<=1080]",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--max-filesize", `${maxFilesizeGb(env)}G`,
    "--break-match-filters", "!is_live",
    "--write-info-json",
    "--no-progress",
    "-o", `${outPathNoExt}.%(ext)s`,
    "--",
    url,
  ];
}

/**
 * `YTDLP_COOKIES_FILE` (a Netscape cookies.txt exported from a logged-in browser) gets past YouTube's bot check on
 * server IPs. yt-dlp writes the jar back when it exits, so each download gets its own copy: the original stays
 * untouched (it is mounted read-only) and parallel downloads don't share one file.
 */
async function cookiesCopy(outPathNoExt: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const file = env.YTDLP_COOKIES_FILE?.trim();
  if (!file) return undefined;
  if (!existsSync(file)) {
    console.warn(`[youtube] YTDLP_COOKIES_FILE=${file} does not exist; downloading without cookies.`);
    return undefined;
  }
  const copy = `${outPathNoExt}.cookies.txt`;
  await copyFile(file, copy);
  return copy;
}

export async function downloadYouTube(
  url: string,
  outPathNoExt: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ videoPath: string; metadata: YouTubeMetadata }> {
  const infoPath = `${outPathNoExt}.info.json`;
  const cookies = await cookiesCopy(outPathNoExt, env);
  let output = "";
  try {
    const { stdout, stderr } = await run("yt-dlp", ytDlpArgs(url, outPathNoExt, env, cookies));
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    // Verified against yt-dlp 2026.10.26: --break-match-filters rejecting a live stream exits 101 with the
    // "does not pass filter" text on stdout (which run() does not keep in the error), so the exit code is the signal.
    if (err instanceof FfmpegError && err.code === 101) throw new YouTubeDownloadError(LIVE_MESSAGE, err.stderrTail);
    const stderr = err instanceof FfmpegError ? err.stderrTail : String(err);
    if (cookies && /Sign in to confirm|not a bot/i.test(stderr)) {
      console.warn("[youtube] blocked even with YTDLP_COOKIES_FILE: the cookies may have expired; export fresh ones (docs/deploy.md).");
    }
    throw new YouTubeDownloadError(mapYtDlpError(stderr), stderr);
  } finally {
    if (cookies) await rm(cookies, { force: true });
  }
  try {
    // An over-size file is a *skip*: yt-dlp exits 0, prints "File is larger than max-filesize" on stdout and writes
    // only the info json.
    if (!existsSync(`${outPathNoExt}.mp4`)) throw new YouTubeDownloadError(mapYtDlpError(output), output.slice(-2000));
    const metadata = mapInfoJson(JSON.parse(await readFile(infoPath, "utf8")));
    return { videoPath: `${outPathNoExt}.mp4`, metadata };
  } finally {
    await rm(infoPath, { force: true });
  }
}
