"use client";

import { useState } from "react";
import { formatTimestamp } from "@digestor/core";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ReviewClip } from "@/lib/review";

const fmt = (ms: number) => formatTimestamp(ms, { tenths: true });
const inputCls = "h-9 w-full rounded-md border border-border bg-white px-2 font-mono text-sm outline-none focus:border-brand";

/** Edit a clip's start/end: previews the range on the proxy, saves via PATCH and shows where the cut snapped to. */
export function EditTimesDialog({
  sessionId,
  clip,
  onClose,
  onSaved,
}: {
  sessionId: string;
  clip: ReviewClip;
  onClose(): void;
  onSaved(clip: ReviewClip): void;
}) {
  const [range, setRange] = useState({ startMs: clip.startMs, endMs: clip.endMs });
  const [start, setStart] = useState(() => fmt(clip.startMs));
  const [end, setEnd] = useState(() => fmt(clip.endMs));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapped, setSnapped] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSnapped(null);
    try {
      const res = await fetch(`/api/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: start.trim(), end: end.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ReviewClip> & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save the times. Try again.");
      const saved = data as ReviewClip;
      setRange({ startMs: saved.startMs, endMs: saved.endMs });
      setStart(fmt(saved.startMs));
      setEnd(fmt(saved.endMs));
      setSnapped(`Snapped to ${fmt(saved.startMs)} → ${fmt(saved.endMs)}`);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the times. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const src = `/api/files/${sessionId}/proxy.mp4#t=${range.startMs / 1000},${range.endMs / 1000}`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit times</DialogTitle>
          <DialogDescription className="truncate">{clip.title}</DialogDescription>
        </DialogHeader>
        <video key={src} src={src} controls preload="metadata" className="aspect-video w-full rounded-lg bg-black" />
        <form onSubmit={save} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
              Start
              <input className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} placeholder="hh:mm:ss.s" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
              End
              <input className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} placeholder="hh:mm:ss.s" />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">Cuts snap to the nearest pause or sentence end, so they never land mid-word.</p>
          {error && (
            <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {snapped && (
            <p role="status" className="rounded-md bg-green-50 p-2 text-sm text-green-800">
              {snapped}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-9 rounded-lg border border-border px-4 text-sm font-semibold">
              {snapped ? "Done" : "Cancel"}
            </button>
            <button type="submit" disabled={busy} className="h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">
              Save
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
