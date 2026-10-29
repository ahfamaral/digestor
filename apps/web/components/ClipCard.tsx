"use client";

import type { ClipLabel, ClipStatus } from "@digestor/core";
import { formatDuration, type ClipNode, type ReviewClip } from "@/lib/review";
import { cn } from "@/lib/utils";

export const LABELS: Record<ClipLabel, { text: string; chip: string; thumb: string }> = {
  heated: { text: "Heated", chip: "bg-[#ffe7e0] text-[#c2410c]", thumb: "from-[#ff7a59] to-[#a3123f]" },
  key_point: { text: "Key point", chip: "bg-[#e3edff] text-[#2f5ad6]", thumb: "from-[#5b8def] to-[#22306f]" },
  light: { text: "Light moment", chip: "bg-[#fff3cf] text-[#a16207]", thumb: "from-[#ffd36e] to-[#c27c0e]" },
};

export interface ClipCardProps {
  clip: ClipNode;
  sessionId: string;
  focusedId: string | null;
  errors: Record<string, string>;
  onFocus(id: string): void;
  onStatus(id: string, status: ClipStatus): void;
  onEdit(id: string): void;
}

const OUT_OF_BOUNDS = "Outside its long clip — edit the times to bring it back inside.";

function ErrorLine({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
      {text}
    </p>
  );
}

/** Large Approve / Neutral / Reject buttons for a long clip; the active one shows its state. */
function StatusButtons({ clip, onStatus, onEdit }: { clip: ReviewClip; onStatus: ClipCardProps["onStatus"]; onEdit: ClipCardProps["onEdit"] }) {
  const base = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-white px-2 text-xs font-semibold";
  const s = clip.status;
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5">
      <button
        type="button"
        aria-pressed={s === "approved"}
        onClick={() => onStatus(clip.id, "approved")}
        className={cn(base, s === "approved" ? "border-green-200 bg-green-100 text-green-700" : "border-foreground bg-foreground text-white")}
      >
        {s === "approved" ? (
          "✓ Approved"
        ) : (
          <>
            Approve <kbd className="rounded border border-white/30 px-1 text-[10px]">A</kbd>
          </>
        )}
      </button>
      <button
        type="button"
        aria-pressed={s === "neutral"}
        onClick={() => onStatus(clip.id, "neutral")}
        className={cn(base, s === "neutral" && "border-stone-300 bg-stone-200 text-stone-700")}
      >
        {s === "neutral" ? "• Neutral" : "Neutral"}
      </button>
      <button
        type="button"
        aria-pressed={s === "rejected"}
        onClick={() => onStatus(clip.id, "rejected")}
        className={cn(base, s === "rejected" && "border-red-200 bg-red-100 text-red-700")}
      >
        {s === "rejected" ? "✕ Rejected" : "Reject"}
      </button>
      <button type="button" onClick={() => onEdit(clip.id)} className={base} aria-label="Edit times">
        ✎ Times
      </button>
    </div>
  );
}

/** Small A / N / R / ✎ controls for a hot take. */
function MiniButtons({ clip, onStatus, onEdit }: { clip: ReviewClip; onStatus: ClipCardProps["onStatus"]; onEdit: ClipCardProps["onEdit"] }) {
  const base = "h-6 w-6 rounded-md border border-border bg-white text-[11px] font-bold";
  const opts: { status: ClipStatus; key: string; label: string; on: string }[] = [
    { status: "approved", key: "A", label: "Approve", on: "border-green-200 bg-green-100 text-green-700" },
    { status: "neutral", key: "N", label: "Neutral", on: "border-stone-300 bg-stone-200 text-stone-700" },
    { status: "rejected", key: "R", label: "Reject", on: "border-red-200 bg-red-100 text-red-700" },
  ];
  return (
    <span className="flex shrink-0 gap-1">
      {opts.map((o) => (
        <button
          key={o.status}
          type="button"
          aria-label={`${o.label} hot take`}
          aria-pressed={clip.status === o.status}
          title={o.label}
          onClick={() => onStatus(clip.id, o.status)}
          className={cn(base, clip.status === o.status && o.on)}
        >
          {o.key}
        </button>
      ))}
      <button type="button" aria-label="Edit hot take times" title="Edit times" onClick={() => onEdit(clip.id)} className={base}>
        ✎
      </button>
    </span>
  );
}

/** One inbox card: a long clip (or a hot take shown on its own) with its hot takes nested inside. */
export function ClipCard({ clip, sessionId, focusedId, errors, onFocus, onStatus, onEdit }: ClipCardProps) {
  const label = LABELS[clip.label];
  const isHotTake = clip.parentId !== null;
  return (
    <article
      data-clip-id={clip.id}
      aria-current={focusedId === clip.id ? "true" : undefined}
      onClick={() => onFocus(clip.id)}
      className={cn(
        "scroll-m-4 overflow-hidden rounded-xl border border-border bg-white",
        focusedId === clip.id && "outline-2 outline-offset-0 outline-foreground",
        (clip.status === "rejected" || clip.status === "neutral") && "opacity-75",
      )}
    >
      <div className={cn("relative aspect-video bg-gradient-to-br", label.thumb)}>
        {clip.thumbKey && (
          // eslint-disable-next-line @next/next/no-img-element -- served by our files route (auth-gated, no image optimizer)
          <img
            src={`/api/files/${sessionId}/thumbs/${clip.id}.jpg`}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        )}
        <span className="absolute right-2 bottom-2 rounded bg-black/65 px-1.5 py-px text-[11px] text-white">
          {formatDuration(clip.endMs - clip.startMs)}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm leading-snug font-bold">
            {isHotTake && <span className="mr-1 text-muted-foreground">↳ Hot take ·</span>}
            {clip.title}
          </h3>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", label.chip)}>
            {label.text} · {clip.score}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">Why: {clip.reason}</p>
        {clip.outOfBounds && <p className="text-xs font-medium text-amber-700">⚠ {OUT_OF_BOUNDS}</p>}
        {clip.children.length > 0 && (
          <ul className="flex flex-col gap-0.5 rounded-lg bg-background px-2 py-1.5 text-xs">
            {clip.children.map((kid) => (
              <li
                key={kid.id}
                data-clip-id={kid.id}
                aria-current={focusedId === kid.id ? "true" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onFocus(kid.id);
                }}
                className={cn("scroll-m-4 rounded-md px-1 py-1", focusedId === kid.id && "outline-2 outline-foreground")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("min-w-0 truncate", kid.status === "rejected" && "line-through opacity-60")}>↳ {kid.title}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">{formatDuration(kid.endMs - kid.startMs)}</span>
                    <MiniButtons clip={kid} onStatus={onStatus} onEdit={onEdit} />
                  </span>
                </div>
                {kid.outOfBounds && <p className="mt-0.5 text-[11px] font-medium text-amber-700">⚠ {OUT_OF_BOUNDS}</p>}
                <ErrorLine text={errors[kid.id]} />
              </li>
            ))}
          </ul>
        )}
        <ErrorLine text={errors[clip.id]} />
        <StatusButtons clip={clip} onStatus={onStatus} onEdit={onEdit} />
      </div>
    </article>
  );
}
