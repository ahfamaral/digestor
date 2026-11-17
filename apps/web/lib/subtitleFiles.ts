import { buildSrt, buildVtt, trackToCues, type ClipFormat } from "@digestor/core";

/**
 * The SRT/VTT text of a track, rendered from its cues (never a stored file). Null when the track has none: an outdated
 * track (built for an older cut, R27) or no cue left after conversion.
 */
export function subtitleText(
  track: { status: string; cues: Parameters<typeof trackToCues>[0] },
  clip: { format: ClipFormat },
  ext: "srt" | "vtt",
): string | null {
  if (track.status === "outdated" || track.cues.length === 0) return null;
  const cues = trackToCues(track.cues, clip.format);
  if (cues.length === 0) return null;
  return ext === "srt" ? buildSrt(cues) : buildVtt(cues);
}

const NAME_GRAPHEMES = 100;

/**
 * A download name from a clip title: no path or reserved characters, no control characters, bounded length. Cut by
 * graphemes, never inside a character: a lone surrogate makes `encodeURIComponent` throw in `contentDisposition`.
 */
export function safeBaseName(title: string): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cleaned), (s) => s.segment);
  const cut = graphemes.slice(0, NAME_GRAPHEMES).join("").trim();
  return cut === "" ? "clip" : cut;
}

/** RFC 5987 `filename*` plus a plain-ASCII `filename` fallback (non-ASCII replaced, quotes and backslashes dropped). */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
