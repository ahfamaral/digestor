import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TMP = fileURLToPath(new URL("./tmp/", import.meta.url));

export default function setup(): void {
  mkdirSync(TMP, { recursive: true });
  const base = ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25"];
  const codec = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
  execFileSync("ffmpeg", [...base, "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", ...codec, "-c:a", "aac", `${TMP}test.mp4`]);
  execFileSync("ffmpeg", [...base, "-t", "6", "-an", ...codec, `${TMP}silent.mp4`]);
  // 100 s, small and low frame rate: long enough for real clip lengths (>= 30 s) in pipeline tests.
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=5",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "100", ...codec, "-preset", "ultrafast", "-c:a", "aac", `${TMP}long.mp4`,
  ]);
}
