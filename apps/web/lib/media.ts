/**
 * Where the voice samples of the context check and Who's who play from: the 360p preview copy once it exists, the
 * extracted audio until then (the copy is its own job and can take a while on a long video).
 */
export function sampleSrc(sessionId: string, proxyReady: boolean): string {
  return `/api/files/${sessionId}/${proxyReady ? "proxy.mp4" : "audio.mp3"}`;
}

/** Pauses every playing `<video>` / `<audio>` under `root`; returns how many it paused. */
export function pauseAllMedia(root: Pick<Document, "querySelectorAll"> = document): number {
  let n = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLMediaElement>("video, audio"))) {
    if (!el.paused) {
      el.pause();
      n++;
    }
  }
  return n;
}
