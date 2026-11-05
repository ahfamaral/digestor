"use client";

import { useEffect, useRef, useState } from "react";
import { formatTimestamp, type Range } from "@digestor/core";
import { cn } from "@/lib/utils";
import { clampHandle, formatTenths, nearestBoundary, stepHandle, timeMarks, trimView } from "@/lib/trim";
import { t } from "@/lib/i18n";

/** How long keyboard nudges wait before the new cut is saved. */
const KEY_COMMIT_MS = 700;

type Which = "start" | "end";

export interface TrimStripProps {
  clipId: string;
  title: string;
  clip: Range;
  /** Changes whenever the saved clip changes (even to the same times), so the fields show the saved value. */
  revision: string;
  durationMs: number;
  /** Cut positions in the strip's window (from the server): where a cut may start / end. */
  points: { starts: number[]; ends: number[] };
  disabled?: boolean;
  /** Saves new bounds (as numbers from the handles). The server snaps again and its value wins. */
  onCommit: (r: Range) => Promise<unknown>;
  /** Saves the typed time fields as they are (the server parses and validates them). */
  onCommitText: (start: string, end: string) => Promise<unknown>;
}

const tenths = (ms: number) => formatTimestamp(Math.max(0, ms), { tenths: true });

/**
 * The zoomed trim strip (clip ± 30 s): two handles that snap to sentence pauses unless Alt/Option is held, keyboard
 * operable (←/→ 0.1 s, Shift 1 s, Home/End), plus exact hh:mm:ss.s fields.
 */
export function TrimStrip({ clipId, title, clip, revision, durationMs, points, disabled, onCommit, onCommitText }: TrimStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Range | null>(null);
  const [dragging, setDragging] = useState<Which | null>(null);
  /** Where the pointer is over the strip, in ms (null when it is elsewhere). */
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const draftRef = useRef<Range | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentRef = useRef<Range | null>(null);
  /** Where a handle drag began, and whether the pointer has moved since (a plain click must not save). */
  const downXRef = useRef<number | null>(null);
  const movedRef = useRef(false);
  // The strip's scale follows the saved clip, so it never rescales under a moving handle.
  const view = trimView(clip, durationMs);
  const shown = draft ?? clip;

  useEffect(() => () => {
    if (keyTimer.current) clearTimeout(keyTimer.current);
  }, []);

  function update(r: Range | null) {
    draftRef.current = r;
    setDraft(r);
  }

  function commit() {
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = null;
    const r = draftRef.current;
    if (!r || r === sentRef.current) return;
    const clear = () => {
      // The saved value (or the old one, on failure) replaces the handles, unless they moved on meanwhile.
      if (draftRef.current === r) update(null);
    };
    if (r.startMs === clip.startMs && r.endMs === clip.endMs) return clear();
    sentRef.current = r;
    void onCommit(r).finally(clear);
  }

  function moveTo(which: Which, ms: number, base: Range): Range {
    const clamped = clampHandle(which, ms, base, view);
    return which === "start" ? { ...base, startMs: clamped } : { ...base, endMs: clamped };
  }

  function msAt(clientX: number): number {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return view.viewStart;
    return view.toMs(((clientX - rect.left) / rect.width) * 100);
  }

  function onPointerDown(which: Which, e: React.PointerEvent<HTMLDivElement>) {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    downXRef.current = e.clientX;
    movedRef.current = false;
    setDragging(which);
    update(draftRef.current ?? clip);
  }

  function onPointerMove(which: Which, e: React.PointerEvent<HTMLDivElement>) {
    if (dragging !== which) return;
    if (!movedRef.current && Math.abs(e.clientX - (downXRef.current ?? e.clientX)) < 3) return;
    movedRef.current = true;
    const raw = msAt(e.clientX);
    const ms = e.altKey ? raw : (nearestBoundary(which === "start" ? points.starts : points.ends, raw) ?? raw);
    update(moveTo(which, ms, draftRef.current ?? clip));
  }

  function onPointerUp(which: Which, e: React.PointerEvent<HTMLDivElement>) {
    if (dragging !== which) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(null);
    if (!movedRef.current) {
      update(null);
      return;
    }
    commit();
  }

  function onKeyDown(which: Which, e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const base = draftRef.current ?? clip;
    const cur = which === "start" ? base.startMs : base.endMs;
    const pts = which === "start" ? points.starts : points.ends;
    const step = e.shiftKey ? 1000 : 100;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = stepHandle(pts, cur, step, !e.altKey);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = stepHandle(pts, cur, -step, !e.altKey);
    else if (e.key === "Home") next = view.viewStart;
    else if (e.key === "End") next = view.viewEnd;
    else if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    } else return;
    e.preventDefault();
    update(moveTo(which, next, base));
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(commit, KEY_COMMIT_MS);
  }

  const handle = (which: Which) => {
    const ms = which === "start" ? shown.startMs : shown.endMs;
    const pct = view.toPct(ms);
    return (
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t(which === "start" ? "prepare.startHandle" : "prepare.endHandle")}
        aria-valuemin={Math.round(view.viewStart)}
        aria-valuemax={Math.round(view.viewEnd)}
        aria-valuenow={Math.round(ms)}
        aria-valuetext={tenths(ms)}
        aria-disabled={disabled || undefined}
        aria-describedby={`trim-help-${clipId}`}
        onPointerDown={(e) => onPointerDown(which, e)}
        onPointerMove={(e) => onPointerMove(which, e)}
        onPointerUp={(e) => onPointerUp(which, e)}
        onPointerCancel={(e) => onPointerUp(which, e)}
        onKeyDown={(e) => onKeyDown(which, e)}
        onBlur={commit}
        style={{ left: `${pct}%` }}
        className={cn(
          "group absolute top-0 bottom-0 z-10 flex w-6 -translate-x-1/2 cursor-ew-resize touch-none items-stretch justify-center rounded outline-none",
          "focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span aria-hidden className={cn("w-1.5 rounded-sm bg-brand", dragging === which && "w-2")} />
        <span
          aria-hidden
          className={cn(
            "absolute -top-7 left-1/2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white opacity-0 group-focus-visible:opacity-100",
            (dragging === which || (hoverMs !== null && !dragging)) && "opacity-100",
          )}
          // Near the strip's ends the label leans inward so it is never clipped.
          style={{ transform: `translateX(${pct < 12 ? "-10%" : pct > 88 ? "-90%" : "-50%"})` }}
        >
          {tenths(ms)}
        </span>
      </div>
    );
  };

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("prepare.trim")}</h3>
      </div>
      <div
        ref={stripRef}
        role="group"
        aria-label={t("prepare.trimStrip", { title, from: tenths(view.viewStart), to: tenths(view.viewEnd) })}
        onPointerMove={(e) => setHoverMs(msAt(e.clientX))}
        onPointerLeave={() => setHoverMs(null)}
        className="relative mt-16 h-12 rounded-md bg-stone-100 select-none"
      >
        {hoverMs !== null && (
          <>
            <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-foreground/60" style={{ left: `${view.toPct(hoverMs)}%` }} />
            <span
              aria-hidden
              className="pointer-events-none absolute -top-14 z-20 -translate-x-1/2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-white"
              style={{ left: `${Math.min(92, Math.max(8, view.toPct(hoverMs)))}%` }}
            >
              {tenths(hoverMs)}
            </span>
          </>
        )}
        {points.starts.map((p) => (
          <span key={p} aria-hidden className="absolute top-2 bottom-2 w-px bg-stone-300" style={{ left: `${view.toPct(p)}%` }} />
        ))}
        <span
          aria-hidden
          className="absolute top-0 bottom-0 border-y-2 border-brand bg-brand/15"
          style={{ left: `${view.toPct(shown.startMs)}%`, width: `${Math.max(0, view.toPct(shown.endMs) - view.toPct(shown.startMs))}%` }}
        />
        {handle("start")}
        {handle("end")}
      </div>
      <div className="relative mt-1 h-6 font-mono text-[10px] text-muted-foreground" aria-hidden>
        {timeMarks(view.viewStart, view.viewEnd).map((m, _i, all) => {
          // Every 10 s gets a tick; the labels thin out to 30 s when the window is long.
          const labelled = all.length <= 8 || m % 30_000 === 0;
          return (
            <span key={m} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: `${view.toPct(m)}%` }}>
              <span className="h-1 w-px bg-stone-400" />
              {labelled && <span>{formatTimestamp(m).replace(/^00:0?/, "")}</span>}
            </span>
          );
        })}
      </div>
      <p aria-hidden className="mt-1 min-h-5 font-mono text-xs text-foreground">
        {dragging ? t("prepare.clipLengthLive", { length: formatTenths(shown.endMs - shown.startMs) }) : ""}
      </p>
      <p id={`trim-help-${clipId}`} className="mt-1 text-xs text-muted-foreground">
        {t("prepare.trimHelp")}
      </p>
      <TimeFields key={revision} clipId={clipId} clip={shown} disabled={disabled} onCommit={onCommitText} />
    </div>
  );
}

/** Exact start/end fields; saved on Enter or when focus leaves the pair with a change. */
function TimeFields({
  clipId, clip, disabled, onCommit,
}: { clipId: string; clip: Range; disabled?: boolean; onCommit: (s: string, e: string) => Promise<unknown> }) {
  const [start, setStart] = useState(tenths(clip.startMs));
  const [end, setEnd] = useState(tenths(clip.endMs));
  const [following, setFollowing] = useState(clip);
  // The saved value these fields started from (they remount when it changes).
  const [saved] = useState({ start: tenths(clip.startMs), end: tenths(clip.endMs) });

  // While a handle moves, the fields follow it.
  if (clip.startMs !== following.startMs || clip.endMs !== following.endMs) {
    setFollowing(clip);
    setStart(tenths(clip.startMs));
    setEnd(tenths(clip.endMs));
  }

  function save() {
    const s = start.trim();
    const e = end.trim();
    if (s === saved.start && e === saved.end) return;
    void onCommit(s, e);
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void) => (
    <label htmlFor={id} className="grid gap-0.5 text-xs font-semibold text-muted-foreground">
      {label}
      <input
        id={id}
        value={value}
        disabled={disabled}
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        placeholder={t("prepare.timeHint")}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
        className="h-8 w-28 rounded-md border border-border bg-white px-2 font-mono text-sm font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
      />
    </label>
  );

  return (
    <div
      className="mt-2 flex flex-wrap items-end gap-3"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save();
      }}
    >
      {field(`start-${clipId}`, t("prepare.startField"), start, setStart)}
      {field(`end-${clipId}`, t("prepare.endField"), end, setEnd)}
    </div>
  );
}
