"use client";

import { useState } from "react";
import { ChevronRightIcon, PlayIcon, SquareIcon } from "lucide-react";
import { MediaPlayer } from "@/components/MediaPlayer";
import { formatLength, formatTimestamp, type SelectionStatus } from "@digestor/core";
import { HighlightChip } from "@/components/HighlightChip";
import { PersonalMarker } from "./PersonalMarker";
import { SpeakerName } from "@/components/Names/SpeakerName";
import type { NamesData, Voice } from "@/lib/names";
import type { MomentView } from "@/lib/briefingFilters";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/lib/i18n";

/** Approve / Skip: both labels share one grid cell, so a button keeps the width of its longer label in both states. */
const STATUS_BTN =
  "inline-grid justify-items-center rounded-md border border-border bg-white px-[7px] py-0.5 text-[11.5px] leading-[1.4] font-medium text-foreground hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-brand";
const STATUS_BUTTONS: { status: SelectionStatus; text: MessageKey; done: MessageKey; label: MessageKey; on: string }[] = [
  { status: "approved", text: "briefing.approve", done: "briefing.approved", label: "briefing.approveLabel", on: "border-green-300 bg-green-100 text-green-800 hover:bg-green-100" },
  { status: "rejected", text: "briefing.skip", done: "briefing.skipped", label: "briefing.skipLabel", on: "border-stone-300 bg-stone-100 text-stone-600 hover:bg-stone-100" },
];
const STATUS_TEXT: Record<SelectionStatus | "proposed", MessageKey> = {
  proposed: "briefing.statusUndecided",
  approved: "briefing.approved",
  rejected: "briefing.skipped",
};
const TITLE: Record<string, string> = {
  exchange: "text-[14.5px] font-semibold",
  passage: "text-sm font-semibold",
  punchline: "text-sm font-medium italic",
};

export interface RowContext {
  sessionId: string;
  /** The session's spoken language (titles and excerpts are in it). */
  language: string | undefined;
  hasVideo: boolean;
  videoRemoved: boolean;
  playingId: string | null;
  /** The row a timeline pin or top-highlight card just jumped to (briefly shaded). */
  flashId: string | null;
  excerpts: Record<string, string>;
  names: NamesData;
  voices: Record<string, Voice[]>;
  sensitive: boolean;
  errors: Record<string, string>;
  onStatus: (id: string, status: SelectionStatus) => void;
  onPlay: (id: string) => void;
}

/**
 * One moment of the Briefing tree and, nested below it with connector lines, the shown moments inside it.
 */
export function MomentRow({ view, ctx, nested = false }: { view: MomentView; ctx: RowContext; nested?: boolean }) {
  const m = view.moment;
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const playing = ctx.playingId === m.id;
  const types = [...new Map(m.highlights.map((h) => [h.type, h])).values()];
  const excerpt = ctx.excerpts[m.id] ?? "";
  const voices = ctx.voices[m.id] ?? [];
  // #t= takes seconds; the proxy route answers Range requests, so only the fragment's bytes load.
  const src = `/api/files/${ctx.sessionId}/proxy.mp4#t=${(m.startMs / 1000).toFixed(1)},${(m.endMs / 1000).toFixed(1)}`;
  const playerLabel = t("preview.playerLabel", { title: m.title });
  const status = view.status ?? "proposed";

  return (
    <li
      id={`moment-${m.id}`}
      data-level={m.granularity}
      className={cn(
        "scroll-mt-24",
        // The connector's short horizontal tick, from the parent's vertical line to this row.
        nested && "relative before:absolute before:top-[22px] before:left-0 before:w-3 before:border-t before:border-border",
      )}
    >
      <div
        data-moment-id={m.id}
        aria-labelledby={`m-title-${m.id}`}
        aria-describedby={`m-status-${m.id}`}
        className={cn(
          "flex flex-wrap items-start gap-x-2.5 gap-y-1.5 rounded-lg py-1.5 pr-2 transition-colors duration-700 motion-reduce:transition-none sm:flex-nowrap",
          nested ? "pl-3.5" : "pl-2",
          view.status === "rejected" && "opacity-75",
          ctx.flashId === m.id && "bg-background",
        )}
      >
        <button
          type="button"
          onClick={() => ctx.onPlay(m.id)}
          disabled={ctx.videoRemoved}
          aria-expanded={playing}
          aria-label={playing ? t("preview.stopLabel", { title: m.title }) : t("preview.playLabel", { title: m.title })}
          aria-describedby={ctx.videoRemoved ? "video-removed" : undefined}
          className="grid size-[26px] shrink-0 place-items-center rounded-full border border-border bg-white text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          {playing ? <SquareIcon aria-hidden className="size-2.5 fill-current" /> : <PlayIcon aria-hidden className="ml-px size-3 fill-current" />}
        </button>

        <div className="min-w-0 flex-1">
          <p id={`m-title-${m.id}`} lang={ctx.language} dir="auto" className={cn("break-words", TITLE[m.granularity])}>
            {m.title}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
            <span className="rounded border border-border px-1.5 text-[10px] tracking-wide uppercase">{t(`granularity.${m.granularity}`)}</span>
            <span className="font-mono">
              {formatTimestamp(m.startMs)} · {formatLength(m.endMs - m.startMs)}
            </span>
            {types.map((h) => (
              <HighlightChip key={h.type} type={h.type} method={h.method} />
            ))}
            <PersonalMarker origin={m.origin} />
            {voices.length > 0 && (
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="sr-only">{t("briefing.speakers")}: </span>
                {voices.map((v) => (
                  <SpeakerName
                    key={`${v.speakerId}:${v.atMs}`}
                    speakerId={v.speakerId}
                    atMs={v.atMs}
                    names={ctx.names}
                    sensitive={ctx.sensitive}
                    sessionId={ctx.sessionId}
                    range={{ startMs: m.startMs, endMs: m.endMs }}
                    language={ctx.language}
                  />
                ))}
              </span>
            )}
            {view.children.length > 0 && <span>· {t("briefing.inside", { n: view.children.length })}</span>}
            <span id={`m-status-${m.id}`} className="sr-only">
              {t(STATUS_TEXT[status])}
            </span>
          </div>
          {m.why && <p className="mt-1 text-xs text-muted-foreground">{t("preview.why", { why: m.why })}</p>}
          {excerpt && (
            <>
              <button
                type="button"
                aria-expanded={transcriptOpen}
                aria-controls={`m-tx-${m.id}`}
                onClick={() => setTranscriptOpen((o) => !o)}
                className="mt-1 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
              >
                <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", transcriptOpen && "rotate-90")} />
                {t("briefing.transcript")}
              </button>
              {transcriptOpen && (
                <p id={`m-tx-${m.id}`} className="mt-1 border-l-[3px] border-stone-300 bg-stone-50 px-2.5 py-1 text-[13px] text-foreground/90">
                  <span className="sr-only">{t("briefing.excerpt")}: </span>
                  <span lang={ctx.language} dir="auto" className="italic">
                    “{excerpt}”
                  </span>
                </p>
              )}
            </>
          )}
          {playing && !ctx.videoRemoved && (
            <div className="mt-2">
              {ctx.hasVideo ? (
                <MediaPlayer kind="video" autoPlay src={src} label={playerLabel} className="aspect-video w-full max-w-xl rounded-lg bg-black" />
              ) : (
                <MediaPlayer kind="audio" autoPlay src={src} label={playerLabel} className="w-full max-w-xl" />
              )}
            </div>
          )}
          {ctx.errors[m.id] && (
            <p role="alert" className="mt-1 text-xs text-red-700">
              {ctx.errors[m.id]}
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-1 max-sm:basis-full max-sm:pl-9">
          {STATUS_BUTTONS.map((b) => {
            const on = view.status === b.status;
            return (
              <button
                key={b.status}
                type="button"
                aria-pressed={on}
                aria-label={t(b.label, { title: m.title })}
                onClick={() => ctx.onStatus(m.id, b.status)}
                className={cn(STATUS_BTN, on && b.on)}
              >
                <span className={cn("[grid-area:1/1]", on && "invisible")}>{t(b.text)}</span>
                <span className={cn("[grid-area:1/1]", !on && "invisible")}>{t(b.done)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {view.children.length > 0 && (
        <ul className="ml-[18px] border-l border-border">
          {view.children.map((c) => (
            <MomentRow key={c.moment.id} view={c} ctx={ctx} nested />
          ))}
        </ul>
      )}
    </li>
  );
}
