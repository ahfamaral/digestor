// Client-safe helpers for a speech's moment in the session's official video (YouTube).

export type VideoMoment = { videoId: string; startS: number; endS: number };

const VIDEO_ID = /^[\w-]{11}$/;
const whole = (n: number) => Math.max(0, Math.floor(n));

/** A position in the video, h:mm:ss ("1:18:42", "0:01:16"). */
export function videoPosition(s: number): string {
  const t = whole(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** A length, m:ss ("5:36", "62:05"). */
export function videoLength(s: number): string {
  const t = whole(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** The privacy-enhanced embed, playing from the speech's start to its end. Null for an id that isn't a YouTube id. */
export function embedUrl(v: VideoMoment): string | null {
  if (!VIDEO_ID.test(v.videoId)) return null;
  return `https://www.youtube-nocookie.com/embed/${v.videoId}?start=${whole(v.startS)}&end=${whole(v.endS)}&autoplay=1&rel=0`;
}

/** The video on YouTube at the speech's start. */
export function watchUrl(v: VideoMoment): string | null {
  if (!VIDEO_ID.test(v.videoId)) return null;
  return `https://www.youtube.com/watch?v=${v.videoId}&t=${whole(v.startS)}s`;
}
