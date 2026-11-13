import { mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FRAME_TIMEOUT_MS, FfmpegError, FfmpegTimeoutError, STDERR_CAP, escapeFilterPath, extractAudio, makeProxy, probe, renderClip, run, thumbnail } from "./ffmpeg.js";
import { buildAss } from "./subtitles.js";

const TMP = fileURLToPath(new URL("../../test/tmp/", import.meta.url));
const TEST_MP4 = join(TMP, "test.mp4");
const AUDIO_M4A = join(TMP, "audio.m4a");
const SILENT_MP4 = join(TMP, "silent.mp4");
const PLAIN = { format: "16:9" as const, cropOffset: 0, credit: null, hasVideo: true };
const outDir = mkdtempSync(join(tmpdir(), "digestor-ffmpeg-"));

describe("escapeFilterPath", () => {
  it("escapes backslash, colon and single quote", () => {
    expect(escapeFilterPath("C:/it's.ass")).toBe("C\\\\:/it\\\\\\'s.ass");
    expect(escapeFilterPath("a,b;[c]")).toBe("a\\,b\\;\\[c\\]");
    expect(escapeFilterPath("/data/s1/clip.ass")).toBe("/data/s1/clip.ass");
  });
});

describe("run", () => {
  it("throws FfmpegError with stderr tail on non-zero exit", async () => {
    const err = await run("ffmpeg", ["-i", "/nonexistent.mp4"]).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.message).toContain("nonexistent");
  });

  it("keeps only a bounded stderr tail", async () => {
    const { stderr } = await run("node", ["-e", "process.stderr.write('x'.repeat(2e6) + 'END')"]);
    expect(stderr.length).toBe(STDERR_CAP);
    expect(stderr.endsWith("END")).toBe(true);
    const err = await run("node", ["-e", "process.stderr.write('x\\n'.repeat(100000)); process.exit(3)"]).catch((e) => e);
    expect(err.stderrTail.split("\n")).toHaveLength(20);
  });
});

describe("ffmpeg wrappers", () => {
  it("probe reports audio presence, size and duration", async () => {
    const p = await probe(TEST_MP4);
    expect(p.hasAudio).toBe(true);
    expect([p.width, p.height]).toEqual([640, 360]);
    expect(Math.abs(p.durationMs - 6000)).toBeLessThan(200);
    expect((await probe(SILENT_MP4)).hasAudio).toBe(false);
  });

  it("probe reports hasVideo false for an m4a", async () => {
    const p = await probe(AUDIO_M4A);
    expect(p).toMatchObject({ hasVideo: false, hasAudio: true, width: 0, height: 0 });
    expect((await probe(TEST_MP4)).hasVideo).toBe(true);
  });

  it("probe does not count embedded cover art as video", async () => {
    const cover = join(outDir, "cover.jpg");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "1", cover]);
    const out = join(outDir, "cover.m4a");
    await run("ffmpeg", ["-y", "-i", AUDIO_M4A, "-i", cover, "-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic", out]);
    expect((await probe(out)).hasVideo).toBe(false);
  });

  it("probe returns lower-case tags", async () => {
    const out = join(outDir, "tagged.mp4");
    await run("ffmpeg", ["-y", "-i", TEST_MP4, "-c", "copy", "-metadata", "Title=Hello", out]);
    expect((await probe(out)).tags.title).toBe("Hello");
  });

  it("extracts mono 16 kHz mp3", async () => {
    const out = join(outDir, "a.mp3");
    await extractAudio(TEST_MP4, out);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels,codec_name", "-of", "csv=p=0", out]);
    expect(stdout.trim()).toBe("mp3,16000,1");
  });

  const audioChannels = async (file: string) =>
    (await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file])).stdout.trim();

  it("makes a 360p proxy with mono audio from a 480p source", async () => {
    const src = join(outDir, "src480.mp4");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-filter_complex", "[1]pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]", "-t", "2", "-c:v", "libx264", "-c:a", "aac", src]);
    expect(await audioChannels(src)).toBe("2");
    const out = join(outDir, "proxy.mp4");
    await makeProxy(src, out);
    const p = await probe(out);
    expect([p.width, p.height]).toEqual([640, 360]);
    expect(p.hasAudio).toBe(true);
    expect(await audioChannels(out)).toBe("1");
  });

  it("makeProxy never upscales a small source", async () => {
    const src = join(outDir, "src180.mp4");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine", "-t", "2", "-c:v", "libx264", "-c:a", "aac", src]);
    const out = join(outDir, "proxy-small.mp4");
    await makeProxy(src, out);
    expect((await probe(out)).height).toBe(180);
  });

  it("makeProxy writes an audio-only proxy for audio input", async () => {
    const out = join(outDir, "audio-proxy.mp4");
    await makeProxy(AUDIO_M4A, out);
    const p = await probe(out);
    expect(p).toMatchObject({ hasVideo: false, hasAudio: true });
    expect(Math.abs(p.durationMs - 6000)).toBeLessThan(200);
  });

  it("makeProxy makes the audio-only proxy mono", async () => {
    const src = join(outDir, "stereo.m4a");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-af", "pan=stereo|c0=c0|c1=c0", "-t", "2", "-c:a", "aac", src]);
    expect(await audioChannels(src)).toBe("2");
    const out = join(outDir, "stereo-proxy.mp4");
    await makeProxy(src, out, { hasVideo: false });
    expect(await audioChannels(out)).toBe("1");
  });

  it("creates a 640-wide jpg thumbnail", async () => {
    const out = join(outDir, "t.jpg");
    await thumbnail(TEST_MP4, 2000, out);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
    expect((await probe(out)).width).toBe(640);
  });

  it("renders a 2 s clip with subtitles", async () => {
    const output = join(outDir, "clip.mp4");
    const assPath = join(outDir, "clip.ass");
    writeFileSync(assPath, buildAss([{ startMs: 0, endMs: 1500, lines: ["Olá mundo"] }], { width: 640, height: 360 }, { style: "yellow", position: "bottom", format: "16:9" }));
    await renderClip({ ...PLAIN, input: TEST_MP4, output, startMs: 1000, endMs: 3000, assPath });
    expect(Math.abs((await probe(output)).durationMs - 2000)).toBeLessThan(150);
  });

  it("renders with an ass path containing : ' , ; [ ] and a space", async () => {
    const dir = join(outDir, "we ird: it's [x],y;z");
    mkdirSync(dir, { recursive: true });
    const assPath = join(dir, "a:b 'c', [d];.ass");
    writeFileSync(assPath, buildAss([{ startMs: 0, endMs: 1000, lines: ["Hi"] }], { width: 640, height: 360 }, { style: "yellow", position: "bottom", format: "16:9" }));
    const output = join(outDir, "weird.mp4");
    await renderClip({ ...PLAIN, input: TEST_MP4, output, startMs: 500, endMs: 2500, assPath });
    expect(Math.abs((await probe(output)).durationMs - 2000)).toBeLessThan(150);
  });

  const base = { format: "16:9" as const, cropOffset: 0, credit: null as string | null, startMs: 500, endMs: 2500 };

  it("9:16 render is 720x1280", async () => {
    const output = join(outDir, "v.mp4");
    await renderClip({ ...base, input: TEST_MP4, output, format: "9:16", cropOffset: 0.5, hasVideo: true });
    const p = await probe(output);
    expect([p.width, p.height]).toEqual([720, 1280]);
    expect(p.hasAudio).toBe(true);
  });

  it("16:9 keeps source size", async () => {
    const output = join(outDir, "h.mp4");
    await renderClip({ ...base, input: TEST_MP4, output, hasVideo: true });
    const p = await probe(output);
    expect([p.width, p.height]).toEqual([640, 360]);
  });

  it("audio-only render has a video stream", async () => {
    const output = join(outDir, "a.mp4");
    await renderClip({ ...base, input: AUDIO_M4A, output, hasVideo: false, credit: "Someone" });
    const p = await probe(output);
    expect(p).toMatchObject({ hasVideo: true, hasAudio: true });
    expect([p.width, p.height]).toEqual([1280, 720]);
    expect(Math.abs(p.durationMs - 2000)).toBeLessThan(200);
    const out2 = join(outDir, "a916.mp4");
    await renderClip({ ...base, input: AUDIO_M4A, output: out2, format: "9:16", hasVideo: false });
    expect([(await probe(out2)).width, (await probe(out2)).height]).toEqual([720, 1280]);
  });

  it("credit text with quotes and colons renders", async () => {
    const output = join(outDir, "c.mp4");
    await renderClip({ ...base, input: TEST_MP4, output, hasVideo: true, credit: `Photo: "O'Neil", 50% [UN] \\ ; done` });
    expect(Math.abs((await probe(output)).durationMs - 2000)).toBeLessThan(200);
  });

  it("portrait source in 9:16 is padded to 720x1280, odd 16:9 source gets even size", async () => {
    const portrait = join(outDir, "portrait.mp4");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=360x720:rate=25:duration=3", "-pix_fmt", "yuv420p", portrait]);
    const out = join(outDir, "p.mp4");
    await renderClip({ ...base, input: portrait, output: out, format: "9:16", hasVideo: true, credit: "Cr" });
    expect([(await probe(out)).width, (await probe(out)).height]).toEqual([720, 1280]);

    const odd = join(outDir, "odd.mp4");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=641x361:rate=25:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv444p", odd]);
    const out2 = join(outDir, "o.mp4");
    await renderClip({ ...base, input: odd, output: out2, hasVideo: true });
    expect([(await probe(out2)).width, (await probe(out2)).height]).toEqual([640, 360]);
  });
});

describe("run with a timeout", () => {
  it("kills a slow process and rejects with a FfmpegTimeoutError", async () => {
    const started = Date.now();
    const err = await run("node", ["-e", "setTimeout(()=>{}, 30000)"], { timeoutMs: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegTimeoutError);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not interfere with a process that finishes in time, and has no limit by default", async () => {
    expect((await run("node", ["-e", "console.log('ok')"], { timeoutMs: 5000 })).stdout.trim()).toBe("ok");
    expect((await run("node", ["-e", "console.log('ok')"])).stdout.trim()).toBe("ok");
  });

  it("killGroup: a timeout also kills the process's children (yt-dlp's ffmpeg)", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "run-group-")), "child.pid");
    const script = `const c=require("child_process").spawn("node",["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},30000)`;
    const err = await run("node", ["-e", script], { timeoutMs: 800, killGroup: true }).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegTimeoutError);
    const fs = await import("node:fs");
    const childPid = Number(fs.readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    // Gone, or a zombie waiting for PID 1 to reap it (the test container's PID 1 doesn't): either way not running.
    const stat = fs.existsSync(`/proc/${childPid}/stat`) ? fs.readFileSync(`/proc/${childPid}/stat`, "utf8") : null;
    expect(stat === null || / Z /.test(stat.slice(stat.lastIndexOf(")")))).toBe(true);
  });

  it("frames get a 60 s limit; encodes get none", () => {
    expect(FRAME_TIMEOUT_MS).toBe(60_000);
  });
});
