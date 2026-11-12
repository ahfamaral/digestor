import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * YouTube's cookies on a server (`YTDLP_COOKIES_FILE`, a cookies.txt exported from a logged-in private window, mounted
 * read-only). yt-dlp writes the jar back after each run with the cookies YouTube refreshed; a browser keeps those, and
 * a session whose refreshed cookies are thrown away after every request gets rotated (seen 2026-11-12: "cookies are no
 * longer valid" after ~20 caption fetches with a fresh copy each time). So one live jar is kept in the data folder
 * (`<DATA_DIR>/.youtube/cookies.txt`, owner-only; the files route serves session folders only) and yt-dlp reads and
 * writes that one. A new export (a different file) starts the jar again from it. Runs are serialised: two yt-dlp
 * processes writing one jar would lose an update.
 */

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` with the live jar's path (or undefined without cookies), one call at a time in this process. */
export function withYouTubeCookies<T>(env: NodeJS.ProcessEnv, fn: (cookiesPath: string | undefined) => Promise<T>): Promise<T> {
  const run = queue.then(async () => fn(await liveJar(env)));
  queue = run.catch(() => undefined);
  return run;
}

/** The live jar, seeded from `YTDLP_COOKIES_FILE` the first time and whenever that file changes; undefined without one. */
export async function liveJar(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const source = env.YTDLP_COOKIES_FILE?.trim();
  if (!source) return undefined;
  if (!existsSync(source)) {
    console.warn(`[youtube] YTDLP_COOKIES_FILE=${source} does not exist; downloading without cookies.`);
    return undefined;
  }
  const dir = join(env.DATA_DIR?.trim() || "/data", ".youtube");
  const jar = join(dir, "cookies.txt");
  const mark = join(dir, "seeded-from.sha1");
  const hash = createHash("sha1").update(await readFile(source)).digest("hex");
  const seeded = existsSync(mark) ? (await readFile(mark, "utf8")).trim() : null;
  if (!existsSync(jar) || seeded !== hash) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(source, jar);
    await chmod(jar, 0o600);
    await writeFile(mark, hash, { mode: 0o600 });
    if (seeded !== null) console.info("[youtube] a new YTDLP_COOKIES_FILE: the live cookie jar starts again from it.");
  }
  return jar;
}
