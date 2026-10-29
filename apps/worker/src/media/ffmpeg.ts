import { spawn } from "node:child_process";

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

export function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => reject(new FfmpegError(cmd, null, String(err.message))));
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new FfmpegError(cmd, code, stderr.trimEnd().split("\n").slice(-20).join("\n")));
    });
  });
}

const ffmpeg = (args: string[]) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]).then(() => undefined);
const secs = (ms: number) => (ms / 1000).toFixed(3);

type ProbeJson = {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; width?: number; height?: number }[];
};

export async function probe(path: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-of", "json", "-show_format", "-show_streams", path]);
  const json = JSON.parse(stdout) as ProbeJson;
  const video = json.streams?.find((s) => s.codec_type === "video");
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(json.format?.tags ?? {})) tags[k.toLowerCase()] = v;
  return {
    durationMs: Math.round(Number(json.format?.duration ?? 0) * 1000),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: json.streams?.some((s) => s.codec_type === "audio") ?? false,
    tags,
  };
}

export const extractAudio = (input: string, output: string) =>
  ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", output]);

export const makeProxy = (input: string, output: string) =>
  ffmpeg([
    "-i", input,
    "-vf", "scale=-2:480",
    "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    output,
  ]);

export const thumbnail = (input: string, atMs: number, output: string) =>
  ffmpeg(["-ss", secs(atMs), "-i", input, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", output]);

/** Escape a path for use as an ffmpeg filter option value (`\`, `:` and `'`). */
export const escapeFilterPath = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

export const renderClip = (o: { input: string; output: string; startMs: number; endMs: number; assPath: string }) =>
  ffmpeg([
    "-ss", secs(o.startMs),
    "-i", o.input,
    "-t", secs(o.endMs - o.startMs),
    "-vf", `ass=${escapeFilterPath(o.assPath)}`,
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    o.output,
  ]);
