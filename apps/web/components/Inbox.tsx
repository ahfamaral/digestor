"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { ClipStatus, ContextCard } from "@digestor/core";
import { AppBar } from "@/components/AppBar";
import { ClipCard, LABELS } from "@/components/ClipCard";
import { ContextBanner } from "@/components/ContextBanner";
import { EditTimesDialog } from "@/components/EditTimesDialog";
import {
  FILTERS,
  countByFilter,
  filterClips,
  flattenTree,
  keyToAction,
  type ClipNode,
  type ReviewClip,
  type ReviewFilter,
} from "@/lib/review";
import { StatusQueue } from "@/lib/statusQueue";
import { cn } from "@/lib/utils";

const FILTER_TEXT: Record<ReviewFilter, string> = {
  all: "All",
  heated: LABELS.heated.text,
  key_point: LABELS.key_point.text,
  light: LABELS.light.text,
  approved: "Approved",
  neutral: "Neutral",
  rejected: "Rejected",
};
const FILTER_ON: Record<ReviewFilter, string> = {
  all: "bg-foreground text-white border-foreground",
  heated: "bg-[#ffe7e0] text-[#c2410c] border-[#c2410c]",
  key_point: "bg-[#e3edff] text-[#2f5ad6] border-[#2f5ad6]",
  light: "bg-[#fff3cf] text-[#a16207] border-[#a16207]",
  approved: "bg-green-100 text-green-700 border-green-700",
  neutral: "bg-stone-200 text-stone-700 border-stone-700",
  rejected: "bg-red-100 text-red-700 border-red-700",
};

/** Applies `patch` to the clip with `id`, wherever it sits in the tree. */
function updateClip(tree: ClipNode[], id: string, patch: (c: ReviewClip) => Partial<ReviewClip>): ClipNode[] {
  return tree.map((p) => {
    const children = p.children.some((k) => k.id === id) ? p.children.map((k) => (k.id === id ? { ...k, ...patch(k) } : k)) : p.children;
    return p.id === id ? { ...p, ...patch(p), children } : children === p.children ? p : { ...p, children };
  });
}

/** PATCHes one clip status; throws with the API's human message on failure. */
async function sendStatus(id: string, status: ClipStatus): Promise<void> {
  const res = await fetch(`/api/clips/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Couldn't save. Try again.");
  }
}

const findClip = (tree: ClipNode[], id: string): ReviewClip | undefined => flattenTree(tree).find((c) => c.id === id);

/** Typing in a field or working in a dialog never triggers inbox shortcuts. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [role='dialog']") !== null;
}

/** Review inbox (human-in-the-loop pause #2): filter, triage with A/N/R and ↓/↑, edit times with E. */
export function Inbox({
  sessionId,
  title,
  initialTree,
  card,
}: {
  sessionId: string;
  title: string;
  initialTree: ClipNode[];
  card: ContextCard | null;
}) {
  const [tree, setTree] = useState(initialTree);
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [focus, setFocus] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [keyboardMoved, setKeyboardMoved] = useState(0);
  // Optimistic, per-clip latest-wins status updates (see lib/statusQueue).
  const [queue] = useState(
    () =>
      new StatusQueue({
        send: sendStatus,
        onDisplay: (id, status) => setTree((t) => updateClip(t, id, () => ({ status }))),
        onError: (id, message) => setError(id, message),
      }),
  );

  function setError(id: string, message: string | null) {
    setErrors((e) => {
      if (message) return { ...e, [id]: message };
      if (!(id in e)) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
  }

  const visible = useMemo(() => filterClips(tree, filter), [tree, filter]);
  const order = useMemo(() => flattenTree(visible), [visible]);
  const counts = useMemo(() => countByFilter(tree), [tree]);
  // A clip that leaves the filter (e.g. rejected under "All") hands focus to whatever now sits at its place.
  const current = (focus.id && order.find((c) => c.id === focus.id)) || order[Math.min(focus.index, order.length - 1)];
  const editing = editingId ? findClip(tree, editingId) : undefined;

  const focusAt = (index: number) => {
    const c = order[index];
    if (c) setFocus({ id: c.id, index });
  };
  const focusId = (id: string) => setFocus({ id, index: Math.max(0, order.findIndex((c) => c.id === id)) });

  const currentId = current?.id;
  useEffect(() => {
    if (!keyboardMoved || !currentId) return;
    document.querySelector(`[data-clip-id="${currentId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [keyboardMoved, currentId]);

  function setStatus(id: string, status: ClipStatus) {
    const shown = findClip(tree, id)?.status;
    if (shown) queue.set(id, status, shown);
  }

  async function onSaved(saved: ReviewClip) {
    setError(saved.id, null);
    setTree((t) => updateClip(t, saved.id, () => ({ startMs: saved.startMs, endMs: saved.endMs, outOfBounds: saved.outOfBounds, renderStatus: saved.renderStatus })));
    // Moving a long clip can push its hot takes in or out of bounds: reload the tree.
    try {
      const res = await fetch(`/api/sessions/${sessionId}/clips`);
      if (!res.ok) return;
      const fresh = (await res.json()) as ClipNode[];
      // Never let the reload overwrite a status change that is still on its way to the server.
      setTree(flattenTree(fresh).reduce((t, c) => {
        const pending = queue.pending(c.id);
        return pending && pending !== c.status ? updateClip(t, c.id, () => ({ status: pending })) : t;
      }, fresh));
    } catch {
      // keep the local update
    }
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (editingId || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    const action = keyToAction(e.key);
    if (!action || !current) return;
    // Holding A/N/R/E must not triage a run of clips; holding ↓/↑ may scroll through them.
    if (e.repeat && action !== "next" && action !== "prev") return;
    e.preventDefault();
    const at = order.findIndex((c) => c.id === current.id);
    if (action === "next" || action === "prev") {
      focusAt(Math.min(order.length - 1, Math.max(0, at + (action === "next" ? 1 : -1))));
      setKeyboardMoved((n) => n + 1);
    } else if (action === "edit") {
      setEditingId(current.id);
    } else {
      setFocus({ id: current.id, index: at });
      setStatus(current.id, action === "approve" ? "approved" : action === "neutral" ? "neutral" : "rejected");
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const approved = counts.approved;
  return (
    <>
      <AppBar current="Review">
        <span title="Rendering arrives in the next step">
          {/* Task 16 wires the render POST. */}
          <button
            type="button"
            disabled
            className="inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Render {approved} approved →
          </button>
        </span>
      </AppBar>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-4 truncate text-xl font-bold tracking-tight">{title}</h1>
        {card && <ContextBanner card={card} />}
        {tree.length === 0 ? (
          <div className="rounded-xl border border-border bg-white p-6 text-sm text-muted-foreground">No moments were found in this video.</div>
        ) : (
          <>
            <div role="group" aria-label="Filter clips" className="mb-3 flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "rounded-full border border-border bg-white px-3 py-1 text-xs font-semibold",
                    filter === f && FILTER_ON[f],
                  )}
                >
                  {FILTER_TEXT[f]} {counts[f]}
                </button>
              ))}
            </div>
            {visible.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-white p-6 text-sm text-muted-foreground">
                No clips match this filter.
              </div>
            ) : (
              <div className="grid items-start gap-3 md:grid-cols-2">
                {visible.map((c) => (
                  <ClipCard
                    key={c.id}
                    clip={c}
                    sessionId={sessionId}
                    focusedId={current?.id ?? null}
                    errors={errors}
                    onFocus={focusId}
                    onStatus={(id, s) => {
                      focusId(id);
                      setStatus(id, s);
                    }}
                    onEdit={(id) => {
                      focusId(id);
                      setEditingId(id);
                    }}
                  />
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              <Kbd>A</Kbd> approve · <Kbd>N</Kbd> neutral · <Kbd>R</Kbd> reject · <Kbd>E</Kbd> edit times · <Kbd>↓</Kbd>
              <Kbd>↑</Kbd> move
            </p>
          </>
        )}
      </main>
      {editing && (
        <EditTimesDialog key={editing.id} sessionId={sessionId} clip={editing} onClose={() => setEditingId(null)} onSaved={onSaved} />
      )}
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mx-0.5 rounded border border-b-2 border-[#ddd9d0] bg-white px-1.5 text-[10px]">{children}</kbd>;
}
