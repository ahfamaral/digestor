// Client calls of Prepare clips. Each resolves to plain views, or throws an Error carrying the API's friendly sentence.
import type { MomentChecks, SubtitlePosition, SubtitleStyle, TrackLineInput } from "@digestor/core";
import { errorMessage } from "./http";
import { toClipView, toTrackView, type ClipView, type TrackView } from "./prepareData";
import { t } from "./i18n";

async function call<T>(url: string, init: RequestInit, map: (body: never) => T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    throw new Error(t("prepare.saveFailed"));
  }
  if (!res.ok) throw new Error(await errorMessage(res, t("prepare.saveFailed")));
  return map((await res.json()) as never);
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export type ClipChange =
  | { start: string; end: string; free?: true }
  | { format?: "16:9" | "9:16"; cropOffset?: number }
  | { subtitleStyle?: SubtitleStyle; subtitlePosition?: SubtitlePosition; subtitleHighlight?: boolean }
  | { credit: string | null }
  | { noCreditNeeded: boolean }
  | { warningsAck: boolean }
  | { protectedAck: boolean }
  | { extend: "next" };

export const patchClip = (id: string, change: ClipChange): Promise<ClipView> =>
  call(`/api/clips/${id}`, json("PATCH", change), toClipView);

/** Joins two overlapping clips; resolves to the surviving (earlier) clip. */
export const mergeClipsApi = (ids: [string, string]): Promise<ClipView> =>
  call("/api/clips/merge", json("POST", { clipIds: ids }), toClipView);

export const undoClip = (id: string): Promise<ClipView> => call(`/api/clips/${id}/undo`, json("POST"), toClipView);

export const fetchChecks = (clipId: string): Promise<MomentChecks | null> =>
  call(`/api/clips/${clipId}/checks`, { method: "GET" }, (b: { checks: MomentChecks | null }) => b.checks);

/** "Check again": asks for the clip's checks once more; true when a new check was queued. */
export const requestChecks = (clipId: string): Promise<boolean> =>
  call(`/api/clips/${clipId}/checks`, json("POST"), (b: { queued: boolean }) => b.queued);

export const fetchTracks = (clipId: string): Promise<TrackView[]> =>
  call(`/api/clips/${clipId}/tracks`, { method: "GET" }, (b: { tracks: Parameters<typeof toTrackView>[0][] }) => b.tracks.map(toTrackView));

/** `rebuild`: replace a ready track with a fresh draft (its edits and approval go). */
export const addTrack = (clipId: string, language: string, opts?: { rebuild?: boolean }): Promise<TrackView> =>
  call(`/api/clips/${clipId}/tracks`, json("POST", opts?.rebuild ? { language, rebuild: true } : { language }), toTrackView);

/** "Remove" a subtitle language that isn't approved (204, nothing to read back). */
export async function deleteTrack(id: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/tracks/${id}`, { method: "DELETE", cache: "no-store" });
  } catch {
    throw new Error(t("prepare.saveFailed"));
  }
  if (!res.ok) throw new Error(await errorMessage(res, t("prepare.saveFailed")));
}

export type TrackChange = { edits: { i: number; text: string }[] } | { lines: TrackLineInput[]; base: string } | { approve: boolean } | { burn: boolean };

export const patchTrack = (id: string, change: TrackChange): Promise<TrackView> =>
  call(`/api/tracks/${id}`, json("PATCH", change), toTrackView);
