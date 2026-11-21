import { checksForClip, formatTimestamp, type Clip, type Moment, type Track } from "@digestor/core";

type Range = { startMs: number; endMs: number };

export const DEFAULT_CONTEXT_S = 60;
export const MAX_CONTEXT_S = 180;

/** The stretches just before and after a clip that get_clip_context shows (null when there is nothing there). */
export function contextWindows(
  clip: Range, durationMs: number, seconds: number = DEFAULT_CONTEXT_S,
): { seconds: number; before: Range | null; after: Range | null } {
  const s = Math.min(MAX_CONTEXT_S, Math.max(1, Math.round(Number.isFinite(seconds) ? seconds : DEFAULT_CONTEXT_S)));
  const ms = s * 1000;
  const before = { startMs: Math.max(0, clip.startMs - ms), endMs: Math.max(0, clip.startMs) };
  const after = { startMs: Math.max(0, clip.endMs), endMs: Math.min(durationMs, clip.endMs + ms) };
  return {
    seconds: s,
    before: before.endMs > before.startMs ? before : null,
    after: after.endMs > after.startMs ? after : null,
  };
}

const ts = (ms: number) => formatTimestamp(Math.max(0, ms));

function checksPart(clip: Pick<Clip, "startMs" | "endMs" | "warningsAck">, moment: Pick<Moment, "startMs" | "endMs" | "checks"> | null): string {
  const { checks, originalCut } = checksForClip(clip, moment);
  if (originalCut) return "checks: made for the original cut";
  if (!checks) return "checks: running";
  if (clip.warningsAck) return "checks: ok";
  const open = [
    !checks.argumentComplete || checks.unansweredQuestion ? "argument" : null,
    checks.contextRisk ? "context" : null,
    checks.reportedSpeech ? "quoting someone else" : null,
    checks.interpreter ? "interpreter" : null,
  ].filter((x): x is string => x !== null);
  return open.length === 0 ? "checks: ok" : `checks: ${open.length} open (${open.join(" / ")})`;
}

/** One clip as list_clips shows it. The title is transcript-derived: the caller wraps the lines in evidence(). */
export function clipLine(a: {
  n: number;
  clip: Clip;
  title: string;
  moment: Pick<Moment, "startMs" | "endMs" | "checks"> | null;
  tracks: Pick<Track, "language" | "status" | "approvedAt">[];
  madeByAsk: boolean;
}): string {
  const { clip } = a;
  const subs = a.tracks.length
    ? a.tracks.map((t) => `${t.language} ${t.status === "outdated" ? "outdated" : t.status === "failed" ? "failed" : t.status === "preparing" ? "preparing" : t.approvedAt ? "approved" : "draft"}`).join(", ")
    : "none";
  return [
    `Clip ${a.n} · ${clip.id}`,
    `[${ts(clip.startMs)}–${ts(clip.endMs)}] ${Math.round((clip.endMs - clip.startMs) / 1000)} s`,
    clip.format,
    `subtitles: ${subs}`,
    `render: ${clip.renderStatus}`,
    checksPart(clip, a.moment),
    a.madeByAsk ? "made with Ask" : "",
    `"${(a.title || "(no title)").replace(/\s+/g, " ")}"`,
  ].filter(Boolean).join(" · ");
}
