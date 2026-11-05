import { z } from "zod";
import type { ProfileId } from "./profiles.ts";

export const SubtitleStyleSchema = z.enum(["yellow", "white", "white_box"]);
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;
export const SubtitlePositionSchema = z.enum(["bottom", "above_banner", "top"]);
export type SubtitlePosition = z.infer<typeof SubtitlePositionSchema>;

/** Shared by the burn (ASS) and the preview: fractions of the video height, pixel values at 1080p. */
export const SUBTITLE_GEOMETRY = {
  fontPct: 0.055,
  outlinePx1080: 4,
  shadowPx1080: 1,
  marginPct: { bottom: 0.06, above_banner: 0.22, top: 0.05 },
  boxOpacity: 0.75,
} as const;

export const SUBTITLE_STYLES: Record<SubtitleStyle, { color: string; bold: boolean; box: boolean }> = {
  yellow: { color: "#FFE600", bold: true, box: false },
  white: { color: "#FFFFFF", bold: true, box: false },
  white_box: { color: "#FFFFFF", bold: false, box: true },
};

const BANNER_PROFILES: readonly ProfileId[] = ["parliament", "supreme_court", "trial", "un"];

/** Chamber and court broadcasts carry a lower-third banner: keep the subtitles above it. */
export function defaultSubtitlePosition(profile: ProfileId): SubtitlePosition {
  return BANNER_PROFILES.includes(profile) ? "above_banner" : "bottom";
}
