// Client calls of Prepare clips. Each resolves to plain views, or throws an Error carrying the API's friendly sentence.
import type { MomentChecks } from "@digestor/core";
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
  | { start: string; end: string }
  | { format?: "16:9" | "9:16"; cropOffset?: number }
  | { credit: string | null }
  | { noCreditNeeded: boolean }
  | { warningsAck: boolean }
  | { protectedAck: boolean }
  | { extend: "next" };

export const patchClip = (id: string, change: ClipChange): Promise<ClipView> =>
  call(`/api/clips/${id}`, json("PATCH", change), toClipView);

export const undoClip = (id: string): Promise<ClipView> => call(`/api/clips/${id}/undo`, json("POST"), toClipView);

export const fetchChecks = (clipId: string): Promise<MomentChecks | null> =>
  call(`/api/clips/${clipId}/checks`, { method: "GET" }, (b: { checks: MomentChecks | null }) => b.checks);

export const fetchTracks = (clipId: string): Promise<TrackView[]> =>
  call(`/api/clips/${clipId}/tracks`, { method: "GET" }, (b: { tracks: Parameters<typeof toTrackView>[0][] }) => b.tracks.map(toTrackView));

export const addTrack = (clipId: string, language: string): Promise<TrackView> =>
  call(`/api/clips/${clipId}/tracks`, json("POST", { language }), toTrackView);

export type TrackChange = { edits: { i: number; text: string }[] } | { approve: true } | { burn: boolean };

export const patchTrack = (id: string, change: TrackChange): Promise<TrackView> =>
  call(`/api/tracks/${id}`, json("PATCH", change), toTrackView);
