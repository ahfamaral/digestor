/**
 * Where the voice samples of the context check and Who's who play from: the 480p preview copy once it exists, the
 * extracted audio until then (the copy is its own job and can take a while on a long video).
 */
export function sampleSrc(sessionId: string, proxyReady: boolean): string {
  return `/api/files/${sessionId}/${proxyReady ? "proxy.mp4" : "audio.mp3"}`;
}
