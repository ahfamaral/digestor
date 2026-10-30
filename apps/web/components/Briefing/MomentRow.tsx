"use client";

import { formatLength, formatTimestamp, type SelectionStatus } from "@digestor/core";
import { HighlightChip } from "@/components/HighlightChip";
import type { MomentView } from "@/lib/briefingFilters";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/lib/i18n";

const ACT =
  "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-white px-2 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand";

const STATUS_BUTTONS: { status: SelectionStatus; key: string; text: MessageKey; label: MessageKey; on: string }[] = [
  { status: "approved", key: "A", text: "briefing.approve", label: "briefing.approveLabel", on: "border-green-300 bg-green-100 text-green-800 hover:bg-green-100" },
  { status: "neutral", key: "N", text: "briefing.neutral", label: "briefing.neutralLabel", on: "border-stone-400 bg-stone-200 text-stone-800 hover:bg-stone-200" },
  { status: "rejected", key: "R", text: "briefing.reject", label: "briefing.rejectLabel", on: "border-red-300 bg-red-100 text-red-800 hover:bg-red-100" },
];
const STATUS_TEXT: Record<SelectionStatus | "proposed", MessageKey> = {
  proposed: "briefing.statusProposed",
  approved: "briefing.approve",
  neutral: "briefing.neutral",
  rejected: "briefing.reject",
};

export interface RowContext {
  sessionId: string;
  /** The session's spoken language (titles and excerpts are in it). */
  language: string | undefined;
  hasVideo: boolean;
  videoRemoved: boolean;
  focusedId: string | null;
  playingId: string | null;
  excerpts: Record<string, string>;
  errors: Record<string, string>;
  onFocusRow: (id: string) => void;
  onStatus: (id: string, status: SelectionStatus) => void;
  onPlay: (id: string) => void;
}

/**
 * One moment of the Full briefing and, nested below it, the finer moments inside it. Rows use a roving tabindex: the
 * focused row is the one Tab reaches and the keyboard shortcuts act on.
 */
export function MomentRow({ view, ctx, nested = false }: { view: MomentView; ctx: RowContext; nested?: boolean }) {
  const m = view.moment;
  const focused = ctx.focusedId === m.id;
  const playing = ctx.playingId === m.id;
  const types = [...new Map(m.highlights.map((h) => [h.type, h])).values()];
  const excerpt = ctx.excerpts[m.id] ?? "";
  // #t= takes seconds; the proxy route answers Range requests, so only the fragment's bytes load.
  const src = `/api/files/${ctx.sessionId}/proxy.mp4#t=${(m.startMs / 1000).toFixed(1)},${(m.endMs / 1000).toFixed(1)}`;
  const playerLabel = t("preview.playerLabel", { title: m.title });
  const personal = m.origin === "ask" ? t("briefing.addedByAsk") : m.origin === "user" ? t("briefing.addedByYou") : null;
  const status = view.status ?? "proposed";

  return (
    <li className={cn(nested && "border-l-2 border-border pl-3 sm:pl-4")}>
      <div
        data-moment-id={m.id}
        tabIndex={focused ? 0 : -1}
        aria-labelledby={`m-title-${m.id}`}
        aria-describedby={`m-status-${m.id}`}
        onFocus={() => ctx.onFocusRow(m.id)}
        className={cn(
          "scroll-m-24 rounded-lg border border-transparent px-2 py-2 outline-none sm:px-3",
          focused && "border-foreground/70 bg-white shadow-sm",
          "focus-visible:ring-2 focus-visible:ring-brand",
          (view.status === "neutral" || view.status === "rejected") && "opacity-75",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-xs text-muted-foreground">
            {formatTimestamp(m.startMs)} · {formatLength(m.endMs - m.startMs)}
          </span>
          <span className="rounded bg-background px-1.5 text-[11px] font-medium text-muted-foreground">{t(`granularity.${m.granularity}`)}</span>
          {m.speakers.length > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="sr-only">{t("briefing.speakers")}: </span>
              {m.speakers.map((id) => t("briefing.speaker", { id })).join(", ")}
            </span>
          )}
          {types.map((h) => (
            <HighlightChip key={h.type} type={h.type} method={h.method} />
          ))}
          {personal && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-violet-800">{personal}</span>
          )}
          <span id={`m-status-${m.id}`} className="sr-only">
            {t(STATUS_TEXT[status])}
          </span>
        </div>

        <p id={`m-title-${m.id}`} lang={ctx.language} dir="auto" className="mt-1 text-sm font-semibold break-words">
          {m.title}
        </p>
        {m.why && <p className="mt-0.5 text-xs text-muted-foreground">{t("preview.why", { why: m.why })}</p>}
        {excerpt && (
          <p className="mt-1.5 border-l-[3px] border-stone-300 bg-stone-50 px-2.5 py-1 text-[13px] text-foreground/90">
            <span className="sr-only">{t("briefing.excerpt")}: </span>
            <span lang={ctx.language} dir="auto" className="italic">
              “{excerpt}”
            </span>
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={ACT}
            onClick={() => ctx.onPlay(m.id)}
            disabled={ctx.videoRemoved}
            aria-expanded={playing}
            aria-label={playing ? t("preview.stopLabel", { title: m.title }) : t("preview.playLabel", { title: m.title })}
            aria-describedby={ctx.videoRemoved ? "video-removed" : undefined}
          >
            {playing ? t("preview.stop") : t("preview.play")}
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          {STATUS_BUTTONS.map((b) => (
            <button
              key={b.status}
              type="button"
              aria-pressed={view.status === b.status}
              aria-label={t(b.label, { title: m.title })}
              onClick={() => ctx.onStatus(m.id, b.status)}
              className={cn(ACT, view.status === b.status && b.on)}
            >
              {t(b.text)}
              <kbd aria-hidden className="rounded border border-b-2 border-[#ddd9d0] bg-white px-1 text-[10px] text-muted-foreground">
                {b.key}
              </kbd>
            </button>
          ))}
        </div>

        {playing && !ctx.videoRemoved && (
          <div className="mt-2">
            {ctx.hasVideo ? (
              <video controls autoPlay preload="none" src={src} aria-label={playerLabel} className="aspect-video w-full max-w-xl rounded-lg bg-black" />
            ) : (
              <audio controls autoPlay preload="none" src={src} aria-label={playerLabel} className="w-full max-w-xl" />
            )}
          </div>
        )}
        {ctx.errors[m.id] && (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {ctx.errors[m.id]}
          </p>
        )}
      </div>

      {view.children.length > 0 && (
        <ul className="mt-1 ml-2 space-y-1 sm:ml-4">
          {view.children.map((c) => (
            <MomentRow key={c.moment.id} view={c} ctx={ctx} nested />
          ))}
        </ul>
      )}
    </li>
  );
}
