import { LANGUAGES, type RenderStatus, type TrackStatus } from "@digestor/core";
import { languageName } from "@/lib/i18n";

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
  approvedAt: Date | null;
  burnStatus: RenderStatus;
  burnKey: string | null;
}

export type BurnState = "none" | "notMade" | "outOfDate" | "making" | "done" | "failed";

export interface ExportLanguageRow {
  language: string;
  /** Subtitle downloads: rendered from the cues on each request, so a draft works too. Null when there is no text. */
  srt: string | null;
  vtt: string | null;
  /** Built for an older cut (R27): no subtitle links until it is rebuilt in Prepare. */
  outdated: boolean;
  approved: boolean;
  /**
   * What the MP4 with subtitles is: `notMade` = requested, never made (stale, no file);
   * `outOfDate` = a file exists but no longer matches (stale, with a file).
   */
  burn: { status: RenderStatus; url: string | null; state: BurnState };
}

export interface ExportRow {
  clipId: string;
  renderStatus: RenderStatus;
  mp4: string | null;
  renderOutOfDate: boolean;
  languages: ExportLanguageRow[];
  /** Inline (no `?download=1`) URLs for the Watch player: the plain MP4 with its text tracks, and each made subtitle video. */
  watch: {
    mp4: string | null;
    tracks: { src: string; srcLang: string; label: string }[];
    burned: { language: string; src: string }[];
  };
}

export const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? languageName(code);

const inline = (sessionId: string, name: string) => `/api/files/${sessionId}/clips/${name}`;
const url = (sessionId: string, name: string) => `${inline(sessionId, name)}?download=1`;

function burnState(status: RenderStatus, key: string | null): BurnState {
  switch (status) {
    case "stale":
      return key ? "outOfDate" : "notMade";
    case "queued":
    case "rendering":
      return "making";
    case "done":
      return key ? "done" : "notMade";
    case "failed":
      return "failed";
    default:
      return "none";
  }
}

/** Groups each clip's download links by language. A `stale` render or burn is "out of date" and has no link. */
export function exportRows(clips: ExportClipInput[], tracks: ExportTrackInput[]): ExportRow[] {
  return clips.map((clip) => {
    const own = tracks.filter((tr) => tr.clipId === clip.id).sort((a, b) => a.language.localeCompare(b.language));
    const hasText = (tr: ExportTrackInput) => tr.status !== "outdated" && tr.cues.some((c) => c.text.trim() !== "");
    const renderDone = clip.renderStatus === "done" && !!clip.renderKey;
    return {
    clipId: clip.id,
    renderStatus: clip.renderStatus,
    mp4: clip.renderStatus === "done" && clip.renderKey ? url(clip.sessionId, `${clip.id}.mp4`) : null,
    renderOutOfDate: clip.renderStatus === "stale",
    watch: {
      mp4: renderDone ? inline(clip.sessionId, `${clip.id}.mp4`) : null,
      tracks: own
        .filter(hasText)
        .map((tr) => ({ src: inline(clip.sessionId, `${clip.id}.${tr.language}.vtt`), srcLang: tr.language, label: languageLabel(tr.language) })),
      burned: own
        .filter((tr) => tr.burnStatus === "done" && tr.burnKey)
        .map((tr) => ({ language: tr.language, src: inline(clip.sessionId, `${clip.id}.${tr.language}.burned.mp4`) })),
    },
    languages: own
      .map((tr) => {
        const outdated = tr.status === "outdated";
        const hasText = !outdated && tr.cues.some((c) => c.text.trim() !== "");
        const base = `${clip.id}.${tr.language}`;
        return {
          language: tr.language,
          srt: hasText ? url(clip.sessionId, `${base}.srt`) : null,
          vtt: hasText ? url(clip.sessionId, `${base}.vtt`) : null,
          outdated,
          approved: tr.approvedAt !== null,
          burn: {
            status: tr.burnStatus,
            url: tr.burnStatus === "done" && tr.burnKey ? url(clip.sessionId, `${base}.burned.mp4`) : null,
            state: burnState(tr.burnStatus, tr.burnKey),
          },
        };
      }),
    };
  });
}

const active = (s: RenderStatus) => s === "queued" || s === "rendering";

/** Whether anything still has to finish (so the page should keep refreshing). */
export function inFlight(rows: ExportRow[]): boolean {
  return rows.some((r) => active(r.renderStatus) || r.languages.some((l) => active(l.burn.status)));
}

/** Subtitle videos Export ready clips would still make: not made, out of date, or failed on an approved track. */
export function toMake(rows: ExportRow[]): number {
  let n = 0;
  for (const r of rows)
    for (const l of r.languages) {
      const s = l.burn.state;
      if (s === "notMade" || s === "outOfDate" || (s === "failed" && l.approved)) n++;
    }
  return n;
}

/** The clips "Export ready clips" sends: every checklist item holds and the moment is still approved. */
export function exportableIds(clips: { id: string; dismissed: boolean; failing: string[] }[]): string[] {
  return clips.filter((c) => c.failing.length === 0 && !c.dismissed).map((c) => c.id);
}
