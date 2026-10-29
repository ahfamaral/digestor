import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8" });

test("ffmpeg has the libass `ass` filter", () => {
  expect(run("ffmpeg", ["-hide_banner", "-filters"])).toMatch(/\bass\b/);
});

test("yt-dlp runs", () => {
  expect(run("yt-dlp", ["--version"]).trim()).not.toBe("");
});

test("Noto Sans CJK font is installed", () => {
  expect(run("fc-list", [])).toContain("Noto Sans CJK");
});
