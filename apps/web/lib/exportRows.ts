import type { RenderStatus, TrackStatus } from "@digestor/core";

export interface ExportClipInput {
  id: string;
  sessionId: string;
  renderStatus: RenderStatus;
  renderKey: string | null;
}

export interface ExportTrackInput {
  clipId: string;
  language: string;
  status: TrackStatus;
  cues: { text: string }[];
  burnStatus: RenderStatus;
  burnKey: string | null;
}

export interface ExportLanguageRow {
  language: string;
  /** Subtitle downloads: rendered from the cues on each request, so a draft works too. Null when there is no text. */
  srt: string | null;
  vtt: string | null;
  /** Built for an older cut (R27): no subtitle links until it is rebuilt in Prepare. */
  outdated: boolean;
  burn: { status: RenderStatus; url: string | null; outOfDate: boolean };
}

export interface ExportRow {
  clipId: string;
  renderStatus: RenderStatus;
  mp4: string | null;
  renderOutOfDate: boolean;
  languages: ExportLanguageRow[];
}

const url = (sessionId: string, name: string) => `/api/files/${sessionId}/clips/${name}?download=1`;

/** Groups each clip's download links by language. A `stale` render or burn is "out of date" and has no link. */
export function exportRows(clips: ExportClipInput[], tracks: ExportTrackInput[]): ExportRow[] {
  return clips.map((clip) => ({
    clipId: clip.id,
    renderStatus: clip.renderStatus,
    mp4: clip.renderStatus === "done" && clip.renderKey ? url(clip.sessionId, `${clip.id}.mp4`) : null,
    renderOutOfDate: clip.renderStatus === "stale",
    languages: tracks
      .filter((tr) => tr.clipId === clip.id)
      .sort((a, b) => a.language.localeCompare(b.language))
      .map((tr) => {
        const outdated = tr.status === "outdated";
        const hasText = !outdated && tr.cues.some((c) => c.text.trim() !== "");
        const base = `${clip.id}.${tr.language}`;
        return {
          language: tr.language,
          srt: hasText ? url(clip.sessionId, `${base}.srt`) : null,
          vtt: hasText ? url(clip.sessionId, `${base}.vtt`) : null,
          outdated,
          burn: {
            status: tr.burnStatus,
            url: tr.burnStatus === "done" && tr.burnKey ? url(clip.sessionId, `${base}.burned.mp4`) : null,
            outOfDate: tr.burnStatus === "stale",
          },
        };
      }),
  }));
}

const active = (s: RenderStatus) => s === "queued" || s === "rendering";

/** Whether anything still has to finish (so the page should keep refreshing). */
export function inFlight(rows: ExportRow[]): boolean {
  return rows.some((r) => active(r.renderStatus) || r.languages.some((l) => active(l.burn.status)));
}
