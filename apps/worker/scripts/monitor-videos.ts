/**
 * Matches session videos now instead of waiting for the 20-minute schedule (`monitor.video`): claims sessions one at
 * a time until none is left or `--max` is reached, pausing `--pause` seconds between them (default 20, gentle on
 * YouTube). Safe to stop and rerun: claims are compare-and-set and finished sessions are skipped.
 *   docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-videos.ts --max 10 --pause 20
 */
import { createDb } from "@digestor/core/server";
import { runSessionVideos } from "../src/monitor/video.js";
import { fetchCaptions } from "../src/youtube/captions.js";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const max = arg("max", 1000);
const pauseS = arg("pause", 20);

const { db, close } = createDb(process.env.DATABASE_URL!);
const started = Date.now();
let done = 0;
try {
  while (done < max) {
    const out = await runSessionVideos({ db, fetch, captions: (id) => fetchCaptions(id) }, 1);
    if (out.results.length === 0) break;
    done++;
    console.log(`[${Math.round((Date.now() - started) / 1000)} s] ${out.results[0]}`);
    if (done < max) await new Promise((r) => setTimeout(r, pauseS * 1000));
  }
  console.log(`monitor-videos: ${done} session(s) in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await close();
}
