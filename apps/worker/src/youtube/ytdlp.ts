import { readFile, rm } from "node:fs/promises";
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

export function mapYtDlpError(stderr: string): string {
  if (!/confirm your age/i.test(stderr) && /Sign in to confirm|not a bot/i.test(stderr))
    return "YouTube blocked this download from the server. Download the video yourself and upload the file instead.";
  if (/Private video/i.test(stderr)) return "This video is private.";
  if (/confirm your age|age-restricted/i.test(stderr)) return "This video is age-restricted and can't be downloaded.";
  if (/Video unavailable/i.test(stderr)) return "This video is unavailable or was removed.";
  return "Couldn't download this video from YouTube.";
}

export async function downloadYouTube(
  url: string,
  outPathNoExt: string,
): Promise<{ videoPath: string; metadata: YouTubeMetadata }> {
  const infoPath = `${outPathNoExt}.info.json`;
  try {
    await run("yt-dlp", [
      "-f", "bv*[height<=1080]+ba/b[height<=1080]",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--write-info-json",
      "--no-progress",
      "-o", `${outPathNoExt}.%(ext)s`,
      "--",
      url,
    ]);
  } catch (err) {
    const stderr = err instanceof FfmpegError ? err.stderrTail : String(err);
    throw new YouTubeDownloadError(mapYtDlpError(stderr), stderr);
  }
  try {
    const metadata = mapInfoJson(JSON.parse(await readFile(infoPath, "utf8")));
    return { videoPath: `${outPathNoExt}.mp4`, metadata };
  } finally {
    await rm(infoPath, { force: true });
  }
}
