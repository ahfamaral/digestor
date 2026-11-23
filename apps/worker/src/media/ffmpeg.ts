import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAVEFORM } from "@digestor/core";

export class FfmpegError extends Error {
  constructor(
    readonly cmd: string,
    readonly code: number | null,
    readonly stderrTail: string,
  ) {
    super(`${cmd} exited with code ${code}\n${stderrTail}`);
    this.name = "FfmpegError";
  }
}

/** The process ran past its time limit and was killed. */
export class FfmpegTimeoutError extends FfmpegError {
  constructor(cmd: string, timeoutMs: number, stderrTail: string) {
    super(cmd, null, `${cmd} timed out after ${Math.round(timeoutMs / 1000)} s and was stopped\n${stderrTail}`);
    this.name = "FfmpegTimeoutError";
  }
}

/** A single frame grab should take a second or two; past this the file is stuck or broken. Encodes (proxy, renders, burns) have no limit. */
export const FRAME_TIMEOUT_MS = 60_000;

/** Max stderr retained per process; only the tail matters for diagnostics. */
export const STDERR_CAP = 64 * 1024;

/**
 * Resolves with the full stdout (unbounded on purpose: ffprobe JSON needs all of it, and
 * callers that stream huge stdout should not use this) and a bounded stderr tail (last STDERR_CAP chars).
 */
export function run(
  cmd: string, args: string[], opts: { timeoutMs?: number; killGroup?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `killGroup`: the process leads its own group, and a timeout kills the whole group (yt-dlp's ffmpeg child too).
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: opts.killGroup === true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
    });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (opts.killGroup && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new FfmpegError(cmd, null, String(err.message)));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new FfmpegTimeoutError(cmd, opts.timeoutMs!, stderr.trimEnd().split("\n").slice(-20).join("\n")));
      if (code === 0) return resolve({ stdout, stderr });
      reject(new FfmpegError(cmd, code, stderr.trimEnd().split("\n").slice(-20).join("\n")));
    });
  });
}

const ffmpeg = (args: string[], opts: { timeoutMs?: number } = {}) =>
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], opts).then(() => undefined);
const secs = (ms: number) => (ms / 1000).toFixed(3);

type ProbeJson = {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[];
};

export async function probe(path: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-of", "json", "-show_format", "-show_streams", path]);
  const json = JSON.parse(stdout) as ProbeJson;
  // Embedded cover art is a "video" stream too, but not a picture of the content.
  const video = json.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(json.format?.tags ?? {})) tags[k.toLowerCase()] = v;
  return {
    durationMs: Math.round(Number(json.format?.duration ?? 0) * 1000),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasVideo: video !== undefined,
    hasAudio: json.streams?.some((s) => s.codec_type === "audio") ?? false,
    tags,
  };
}

export const extractAudio = (input: string, output: string) =>
  ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", output]);

/** The clip's audio only (`.m4a`, AAC 160 kb/s as the rendered video's track), cut from the original: the Export "Audio" file. */
export const cutAudio = (o: { input: string; output: string; startMs: number; endMs: number }) =>
  ffmpeg([
    "-ss", secs(o.startMs), "-i", o.input, "-t", secs(o.endMs - o.startMs),
    "-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", o.output,
  ]);

/**
 * 360p H.264 preview copy (a smaller source keeps its height, never upscaled) with mono 64 kb/s voice audio; audio-only
 * sources get an AAC-only `proxy.mp4` (browsers play it in <audio>). 360p keeps name captions and on-screen text readable.
 */
export const makeProxy = (input: string, output: string, opts: { hasVideo?: boolean } = {}) =>
  ffmpeg(opts.hasVideo === false ? ["-i", input, "-vn", "-c:a", "aac", "-ac", "1", "-b:a", "64k", "-movflags", "+faststart", output] : [
    "-i", input,
    "-vf", "scale=-2:'trunc(min(360,ih)/2)*2'",
    "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ac", "1", "-b:a", "64k",
    "-movflags", "+faststart",
    output,
  ]);

/** One JPEG frame at `atMs`, scaled to `width` px wide. */
export const frame = (input: string, atMs: number, output: string, width: number) =>
  ffmpeg(["-ss", secs(atMs), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", output], { timeoutMs: FRAME_TIMEOUT_MS });

export const thumbnail = (input: string, atMs: number, output: string) => frame(input, atMs, output, 640);

/**
 * Escape a path for use as the value of a filter option inside a `-vf` string. ffmpeg unescapes twice:
 * first the filtergraph parser (`\`, `'`, `,` `;` `[` `]`), then the filter option parser (`\`, `:`, `'`),
 * so we escape for the option level first and then for the graph level.
 * Pipeline code still uses safe generated names (`<clipId>.ass` under the data dir); this is defence in depth.
 */
export const escapeFilterPath = (p: string) =>
  p.replace(/[\\:']/g, "\\$&").replace(/[\\',;[\]]/g, "\\$&");

const NOTO_SANS = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf";
const WAVE_BG = `0x${WAVEFORM.background.slice(1)}`;

export type ClipFormat = "16:9" | "9:16";

/** Output size of a render: 9:16 is always 720x1280; 16:9 keeps the source size (1280x720 for audio-only). */
export function renderSize(format: ClipFormat, source: { hasVideo: boolean; width: number; height: number }): { width: number; height: number } {
  if (format === "9:16") return { width: 720, height: 1280 };
  return source.hasVideo && source.width > 0
    ? { width: Math.max(2, source.width - (source.width % 2)), height: Math.max(2, source.height - (source.height % 2)) }
    : { width: 1280, height: 720 };
}

export type RenderClipOptions = {
  input: string;
  output: string;
  startMs: number;
  endMs: number;
  format: ClipFormat;
  cropOffset: number;
  credit: string | null;
  hasVideo: boolean;
  assPath?: string;
};

/**
 * One filter graph: crop/scale (9:16) or a waveform on a dark background (audio-only), then the credit line
 * (`drawtext` reading a temp `textfile`, so user text never touches the command line) and `ass=` subtitles.
 */
export async function renderClip(o: RenderClipOptions): Promise<void> {
  const src = o.hasVideo ? await probe(o.input) : { hasVideo: false, width: 0, height: 0 };
  const { width, height } = renderSize(o.format, { hasVideo: src.hasVideo, width: src.width, height: src.height });
  const chain: string[] = [];
  let head: string;
  if (o.hasVideo) {
    head = "[0:v]";
    if (o.format === "9:16" && src.width < (src.height * 9) / 16) {
      // Too narrow to crop: fit inside the frame and pad with the waveform background colour.
      chain.push("scale=720:1280:force_original_aspect_ratio=decrease", `pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=${WAVE_BG}`);
    } else if (o.format === "9:16") {
      const x = `(iw-ih*9/16)*(${o.cropOffset}+1)/2`;
      chain.push(`crop=ih*9/16:ih:${x}:0`, "scale=720:1280");
    } else {
      chain.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    }
    chain.push("setsar=1");
  } else {
    const size = `${width}x${height}`;
    head = `[0:a]showwaves=s=${size}:mode=cline:rate=25:colors=white[w];color=c=${WAVE_BG}:s=${size}:r=25[bg];[bg][w]overlay=shortest=1,`;
  }

  const tmp = await mkdtemp(join(tmpdir(), "digestor-render-"));
  try {
    if (o.assPath) chain.push(`ass=${escapeFilterPath(o.assPath)}`);
    if (o.credit) {
      const textFile = join(tmp, "credit.txt");
      await writeFile(textFile, o.credit, "utf8");
      const fontSize = Math.max(8, Math.round(height * 0.025));
      const margin = Math.round(height * 0.02);
      chain.push(
        `drawtext=fontfile=${escapeFilterPath(NOTO_SANS)}:textfile=${escapeFilterPath(textFile)}:expansion=none` +
          `:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${Math.round(fontSize * 0.4)}` +
          `:x=w-tw-${margin}:y=h-th-${margin}`,
      );
    }
    chain.push("format=yuv420p");
    const graph = `${head}${chain.join(",")}[v]`;
    await ffmpeg([
      "-ss", secs(o.startMs),
      "-i", o.input,
      "-t", secs(o.endMs - o.startMs),
      "-filter_complex", graph,
      "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      o.output,
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
