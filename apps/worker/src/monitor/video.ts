import {
  claimSessionVideo, finishSessionVideo, queueSessionVideos, replaceSessionSpeechVideos, speechesInRange, type Db, type SessionVideoClaim,
} from "@digestor/core/server";
import type { Captions } from "../youtube/captions.js";
import { YouTubeDownloadError } from "../youtube/ytdlp.js";
import { fetchEventVideoId } from "./camara.js";
import { alignSpeeches, alignWithoutStart, captionWords, secondsBetween } from "./videoAlign.js";

export const MONITOR_VIDEO_QUEUE = "monitor.video";
/** One session every 5 minutes (12 an hour): a steady trickle rather than bursts, gentle on YouTube and its cookies. */
export const MONITOR_VIDEO_CRON = "2-59/5 * * * *";
export const SESSIONS_PER_RUN = 1;

const HOUR = 3_600_000;
/** A live stream starting further than this from the session's official start is not trusted as its anchor. */
const MAX_START_GAP_S = 6 * 3600;
/** Brasília has no daylight saving time since 2019: local = UTC − 3 h. */
const BRASILIA_OFFSET_MS = -3 * HOUR;

export type VideoDeps = {
  db: Db;
  fetch: typeof fetch;
  captions: (videoId: string) => Promise<Captions>;
  /** Pause between two sessions of one run (the real job waits a few seconds). */
  pause?: () => Promise<void>;
  now?: () => Date;
};

/** An epoch second as a Brasília local timestamp ("YYYY-MM-DD HH:MM:SS"), the form `parl_speeches.starts_at` uses. */
export function brasiliaLocal(epochS: number): string {
  return new Date(epochS * 1000 + BRASILIA_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

const addSeconds = (local: string, s: number) => brasiliaLocal(Date.parse(`${local.replace(" ", "T")}Z`) / 1000 - BRASILIA_OFFSET_MS / 1000 + s);

/** When a session without a usable video is looked at again: soon at first, then once a week. */
function retryAfter(attempts: number, now: Date, firstHours: number): Date {
  return new Date(now.getTime() + (attempts >= 8 ? 7 * 24 : firstHours * Math.min(attempts, 4)) * HOUR);
}

/** One claimed session: find its video, fetch the captions once, place its speeches, record the outcome. */
export async function matchSessionVideo(deps: VideoDeps, claim: SessionVideoClaim): Promise<string> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const { sessionId, attempts } = claim;
  try {
    const videoId = await fetchEventVideoId(deps.fetch, sessionId);
    if (!videoId) {
      await finishSessionVideo(db, sessionId, { status: "no_video", videoId: null, retryAt: retryAfter(attempts, now, 6) });
      return "no_video";
    }
    const { vtt, info } = await deps.captions(videoId);
    if (!vtt || info.live || info.durationS === null) {
      const error = info.live ? "The stream is still live or hasn't started." : "YouTube has no automatic captions for this video yet.";
      await finishSessionVideo(db, sessionId, { status: "no_captions", videoId, error, retryAt: retryAfter(attempts, now, 3) });
      return "no_captions";
    }
    // A recorded live stream's start anchors the stamps; a video uploaded later (or one far from the session's own
    // start) is anchored on the session's start and its real start measured from the captions.
    const sessionStart = `${claim.startsAt.slice(0, 16)}:00`;
    const live = info.wasLive && info.startEpochS !== null ? brasiliaLocal(info.startEpochS) : null;
    const anchored = live !== null && Math.abs(secondsBetween(sessionStart, live)) < MAX_START_GAP_S;
    const from = anchored ? live : sessionStart;
    const speeches = await speechesInRange(db, addSeconds(from, -45 * 60), addSeconds(from, info.durationS + 10 * 60));
    const words = captionWords(vtt);
    const { streamStart, matches } = anchored
      ? { streamStart: live, matches: alignSpeeches(words, live, info.durationS, speeches) }
      : alignWithoutStart(words, sessionStart, info.durationS, speeches);
    await replaceSessionSpeechVideos(db, sessionId, videoId, matches);
    await finishSessionVideo(db, sessionId, {
      status: "done", videoId, streamStart, durationS: Math.round(info.durationS), spoken: speeches.length, matched: matches.length,
    });
    return `done ${matches.length}/${speeches.length}`;
  } catch (err) {
    const error = err instanceof YouTubeDownloadError ? err.message : "Matching the session's video failed.";
    console.warn(`monitor.video: session ${sessionId} failed:`, err instanceof YouTubeDownloadError ? err.stderr.slice(-500) : err);
    await finishSessionVideo(db, sessionId, { status: "failed", error, retryAt: retryAfter(attempts, now, 1) });
    return "failed";
  }
}

/**
 * One scheduled run: queue new held sessions (and done ones with new speech texts), then match up to `max` sessions.
 * A session's failure is recorded on its row and retried later; it never throws, so pg-boss doesn't repeat the run.
 */
export async function runSessionVideos(deps: VideoDeps, max = SESSIONS_PER_RUN): Promise<{ queued: { added: number; requeued: number }; results: string[] }> {
  const queued = await queueSessionVideos(deps.db);
  const results: string[] = [];
  for (let n = 0; n < max; n++) {
    const claim = await claimSessionVideo(deps.db, deps.now?.() ?? new Date());
    if (!claim) break;
    if (n > 0) await deps.pause?.();
    results.push(`${claim.sessionId}: ${await matchSessionVideo(deps, claim)}`);
  }
  return { queued, results };
}
