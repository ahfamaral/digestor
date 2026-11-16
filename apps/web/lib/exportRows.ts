import { LANGUAGES, type ChecklistId, type RenderStatus, type TrackStatus } from "@digestor/core";
import { languageName, t } from "@/lib/i18n";

export interface ExportClipInput {
  id: string;
  sessionId: string;
  renderStatus: RenderStatus;
  renderKey: string | null;
  /**
   * The export checklist passes now (`exportChecklist`, the rule Export applies before rendering). Only then are the
   * clip's made videos (plain and with subtitles) offered: a clip package renders before the checklist is done.
   */
  cleared: boolean;
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

/**
 * Groups each clip's download links by language. A `stale` render or burn is "out of date" and has no link, and no
 * video is offered while the clip's checklist fails (`cleared`); SRT/VTT stay downloadable, drafts too.
 */
export function exportRows(clips: ExportClipInput[], tracks: ExportTrackInput[]): ExportRow[] {
  return clips.map((clip) => {
    const own = tracks.filter((tr) => tr.clipId === clip.id).sort((a, b) => a.language.localeCompare(b.language));
    const hasText = (tr: ExportTrackInput) => tr.status !== "outdated" && tr.cues.some((c) => c.text.trim() !== "");
    const renderDone = clip.cleared && clip.renderStatus === "done" && !!clip.renderKey;
    const burnDone = (tr: ExportTrackInput) => clip.cleared && tr.burnStatus === "done" && !!tr.burnKey;
    return {
    clipId: clip.id,
    renderStatus: clip.renderStatus,
    mp4: renderDone ? url(clip.sessionId, `${clip.id}.mp4`) : null,
    renderOutOfDate: clip.renderStatus === "stale",
    watch: {
      mp4: renderDone ? inline(clip.sessionId, `${clip.id}.mp4`) : null,
      tracks: own
        .filter(hasText)
        .map((tr) => ({ src: inline(clip.sessionId, `${clip.id}.${tr.language}.vtt`), srcLang: tr.language, label: languageLabel(tr.language) })),
      burned: own
        .filter(burnDone)
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
            url: burnDone(tr) ? url(clip.sessionId, `${base}.burned.mp4`) : null,
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

/** Subtitle videos "Make the videos" would still make: not made, out of date, or failed on an approved track. */
export function toMake(rows: ExportRow[]): number {
  let n = 0;
  for (const r of rows)
    for (const l of r.languages) {
      const s = l.burn.state;
      if (s === "notMade" || s === "outOfDate" || (s === "failed" && l.approved)) n++;
    }
  return n;
}

/** One rule for "ready to export": every checklist item holds and the moment is still approved. */
export function isExportReady(c: { dismissed: boolean; failing: string[] }): boolean {
  return c.failing.length === 0 && !c.dismissed;
}

/** The clips "Make the videos" (Export) sends. */
export function exportableIds(clips: { id: string; dismissed: boolean; failing: string[] }[]): string[] {
  return clips.filter(isExportReady).map((c) => c.id);
}

export type ExportStatus =
  | { kind: "rendered" }
  | { kind: "rendering" }
  | { kind: "needs"; actions: ChecklistId[] }
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "stale" }
  | { kind: "dismissed" };

/**
 * The one status of an Export row. What exists comes first (a made file is downloadable while the checklist passes:
 * `exportRows` drops it otherwise); then what is missing, as actions. A dismissed approval keeps its own label.
 */
export function exportStatus(c: { dismissed: boolean; failing: ChecklistId[]; row: ExportRow }): ExportStatus {
  const { row } = c;
  if (active(row.renderStatus)) return { kind: "rendering" };
  if (row.mp4 !== null) return { kind: "rendered" };
  if (c.dismissed) return { kind: "dismissed" };
  // To-dos come first: a failed or stale render of a clip whose checklist fails can't be fixed by exporting again.
  if (c.failing.length > 0) return { kind: "needs", actions: c.failing };
  if (row.renderStatus === "failed") return { kind: "failed" };
  if (row.renderStatus === "stale") return { kind: "stale" };
  return { kind: "ready" };
}

/** The status as one short sentence ("Needs: Add a credit line; ..."). */
export function statusLabel(s: ExportStatus): string {
  if (s.kind === "needs") return t("exportScreen.status.needs", { actions: s.actions.map((id) => t(`exportScreen.action.${id}`)).join("; ") });
  return t(`exportScreen.status.${s.kind}`);
}

/** Rendered clips first; the order inside each group is kept. */
export function renderedFirst<T extends { row: ExportRow }>(clips: T[]): T[] {
  return [...clips.filter((c) => c.row.mp4 !== null), ...clips.filter((c) => c.row.mp4 === null)];
}

/** Keeps a fixed order (taken once on load) so rows don't jump while polling; unknown ids go last. */
export function sortByOrder<T extends { id: string }>(clips: T[], order: string[]): T[] {
  const at = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return [...clips].sort((a, b) => at(a.id) - at(b.id));
}
