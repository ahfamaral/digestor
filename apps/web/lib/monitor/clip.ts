// "Clip this speech": a speech's moment in the plenary video opened as a new Digestor session. Client-safe.

import type { VideoMoment } from "./video";

/** Seconds kept before and after the speech's moment (the alignment is approximate; the transcript shows the real start). */
export const CLIP_PAD_S = 20;

/** Off unless `MONITOR_CLIP_ENABLED=true`: the download runs yt-dlp, which a server IP YouTube blocks can't do. */
export function monitorClipEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MONITOR_CLIP_ENABLED === "true";
}

/** The part of the video to download, whole seconds: the moment ± 20 s, clamped to the video (its length when known). */
export function clipSection(v: Pick<VideoMoment, "startS" | "endS">, durationS: number | null = null): { startS: number; endS: number } {
  const startS = Math.max(0, Math.floor(v.startS) - CLIP_PAD_S);
  const end = Math.ceil(v.endS) + CLIP_PAD_S;
  return { startS, endS: durationS !== null && durationS > startS ? Math.min(end, durationS) : end };
}

/** About how many minutes the download is (at least 1), for the confirm dialog. */
export function clipMinutes(v: Pick<VideoMoment, "startS" | "endS">): number {
  const { startS, endS } = clipSection(v);
  return Math.max(1, Math.round((endS - startS) / 60));
}

/** "Chico Alencar (PSOL-RJ)", or the name alone without a party and state. */
export function speakerLabel(name: string, party: string | null, uf: string | null): string {
  const tag = [party, uf].filter(Boolean).join("-");
  return tag ? `${name} (${tag})` : name;
}
