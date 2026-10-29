"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LABELS } from "@/components/ClipCard";
import { approvedClips, formatDuration, type ClipNode, type ReviewClip } from "@/lib/review";
import { cn } from "@/lib/utils";

type RenderStatus = ReviewClip["renderStatus"];

const POLL_MS = 2000;
const inProgress = (s: RenderStatus) => s === "queued" || s === "rendering";
const STATUS_TEXT: Record<RenderStatus, string> = {
  none: "Not rendered yet",
  queued: "Queued…",
  rendering: "Rendering…",
  done: "Ready",
  failed: "Render failed.",
  stale: "Times changed since this render.",
};

/** The session's approved clips, fresh from the API. */
async function loadApproved(sessionId: string): Promise<ReviewClip[]> {
  const res = await fetch(`/api/sessions/${sessionId}/clips`, { cache: "no-store" });
  if (!res.ok) throw new Error(`clips: ${res.status}`);
  return approvedClips((await res.json()) as ClipNode[]);
}

/** Export list: approved clips with live render status, downloads when ready, re-render when stale or failed. */
export function ExportList({ sessionId, language, initialClips }: { sessionId: string; language: string | null; initialClips: ReviewClip[] }) {
  const [clips, setClips] = useState(initialClips);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const busy = clips.some((c) => inProgress(c.renderStatus));

  async function refresh(): Promise<void> {
    setClips(await loadApproved(sessionId));
  }

  // Re-read on mount and whenever the router shows this page again: Next keeps visited pages (and their
  // client state) alive, so coming back from review would otherwise show the old render statuses.
  // Then poll every 2 s while any approved clip is queued or rendering.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      loadApproved(sessionId).then(
        (fresh) => {
          if (stopped) return;
          setClips(fresh);
          if (fresh.some((c) => inProgress(c.renderStatus))) timer = setTimeout(load, POLL_MS);
        },
        () => {
          if (!stopped) timer = setTimeout(load, POLL_MS); // offline for a moment: try again
        },
      );
    // On mount load now; when a render was just started (busy flipped on), the first check is in 2 s.
    if (busy) timer = setTimeout(load, POLL_MS);
    else void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [busy, sessionId]);

  async function rerender() {
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/render`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Couldn't start the render. Try again.");
      }
      await refresh().catch(() => {}); // the statuses still update on the next visit
    } catch {
      setError("Couldn't start the render. Try again.");
    } finally {
      setPosting(false);
    }
  }

  const subtitles = language ? ` · subtitles ${language.toUpperCase()}` : "";
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {clips.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No approved clips.</p>
      ) : (
        <ul className="divide-y divide-border">
          {clips.map((c) => (
            <li key={c.id} data-clip-id={c.id} className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap">
              <Thumb sessionId={sessionId} clip={c} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{c.title}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDuration(c.endMs - c.startMs)} · {c.parentId === null ? "Long clip" : "Hot take"}
                  {subtitles}
                </p>
                {c.renderStatus !== "done" && (
                  <p
                    aria-live="polite"
                    className={cn(
                      "mt-0.5 text-xs",
                      c.renderStatus === "failed" ? "text-red-700" : c.renderStatus === "stale" ? "text-amber-700" : "text-muted-foreground",
                    )}
                  >
                    {STATUS_TEXT[c.renderStatus]}
                  </p>
                )}
                {inProgress(c.renderStatus) && (
                  <div className="mt-1 h-1 w-40 overflow-hidden rounded-full bg-[#efece5]">
                    <div className={cn("h-full rounded-full bg-brand", c.renderStatus === "queued" ? "w-[8%]" : "w-1/2 animate-pulse")} />
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                {c.renderStatus === "done" ? (
                  <>
                    <a
                      href={`/api/files/${sessionId}/clips/${c.id}.mp4?download=1`}
                      className="inline-flex h-8 items-center rounded-lg border border-foreground bg-foreground px-3 text-xs font-semibold text-white"
                    >
                      ⬇ MP4
                    </a>
                    <a
                      href={`/api/files/${sessionId}/clips/${c.id}.srt?download=1`}
                      className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-semibold"
                    >
                      .srt
                    </a>
                  </>
                ) : c.renderStatus === "stale" || c.renderStatus === "failed" || c.renderStatus === "none" ? (
                  <button
                    type="button"
                    disabled={posting}
                    onClick={rerender}
                    className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-semibold disabled:opacity-60"
                  >
                    {c.renderStatus === "none" ? "Render" : "Re-render"}
                  </button>
                ) : (
                  <span className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-semibold opacity-50">
                    ⬇ MP4
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border pt-3">
        {busy ? (
          <span title="Wait for the renders to finish." className="cursor-not-allowed text-sm text-muted-foreground opacity-60">
            ← Back to review
          </span>
        ) : (
          <Link href={`/s/${sessionId}`} className="text-sm font-semibold text-foreground hover:underline">
            ← Back to review
          </Link>
        )}
      </div>
    </div>
  );
}

function Thumb({ sessionId, clip }: { sessionId: string; clip: ReviewClip }) {
  return (
    <div className={cn("relative aspect-video w-20 shrink-0 overflow-hidden rounded-md bg-gradient-to-br", LABELS[clip.label].thumb)}>
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
    </div>
  );
}
