import { mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FfmpegError, STDERR_CAP, escapeFilterPath, extractAudio, makeProxy, probe, renderClip, run, thumbnail } from "./ffmpeg.js";
import { buildAss } from "./subtitles.js";

const TMP = fileURLToPath(new URL("../../test/tmp/", import.meta.url));
const TEST_MP4 = join(TMP, "test.mp4");
const SILENT_MP4 = join(TMP, "silent.mp4");
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

  it("makes a 480p proxy", async () => {
    const out = join(outDir, "proxy.mp4");
    await makeProxy(TEST_MP4, out);
    const p = await probe(out);
    expect(p.height).toBe(480);
    expect(p.hasAudio).toBe(true);
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
    writeFileSync(assPath, buildAss([{ startMs: 0, endMs: 1500, lines: ["Olá mundo"] }], { width: 640, height: 360 }));
    await renderClip({ input: TEST_MP4, output, startMs: 1000, endMs: 3000, assPath });
    expect(Math.abs((await probe(output)).durationMs - 2000)).toBeLessThan(150);
  });

  it("renders with an ass path containing : ' , ; [ ] and a space", async () => {
    const dir = join(outDir, "we ird: it's [x],y;z");
    mkdirSync(dir, { recursive: true });
    const assPath = join(dir, "a:b 'c', [d];.ass");
    writeFileSync(assPath, buildAss([{ startMs: 0, endMs: 1000, lines: ["Hi"] }], { width: 640, height: 360 }));
    const output = join(outDir, "weird.mp4");
    await renderClip({ input: TEST_MP4, output, startMs: 500, endMs: 2500, assPath });
    expect(Math.abs((await probe(output)).durationMs - 2000)).toBeLessThan(150);
  });
});
