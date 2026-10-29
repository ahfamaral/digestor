import type { ClipLabel, ClipOrigin, ClipStatus } from "@digestor/core";

/** The clip fields the review inbox uses (a DB `Clip` or its JSON form both fit). */
export interface ReviewClip {
  id: string;
  sessionId: string;
  parentId: string | null;
  title: string;
  label: ClipLabel;
  score: number;
  reason: string;
  startMs: number;
  endMs: number;
  status: ClipStatus;
  origin: ClipOrigin;
  outOfBounds: boolean;
  thumbKey: string | null;
  renderStatus: "none" | "queued" | "rendering" | "done" | "failed" | "stale";
}

export type ClipNode<T extends ReviewClip = ReviewClip> = T & { children: T[] };

export type ReviewAction = "approve" | "neutral" | "reject" | "edit" | "next" | "prev";
export type ReviewFilter = "all" | "heated" | "key_point" | "light" | "approved" | "neutral" | "rejected";
export const FILTERS: readonly ReviewFilter[] = ["all", "heated", "key_point", "light", "approved", "neutral", "rejected"];

const KEYS: Record<string, ReviewAction> = {
  a: "approve",
  n: "neutral",
  r: "reject",
  e: "edit",
  ArrowDown: "next",
  ArrowUp: "prev",
};

/** Inbox keyboard: A approve · N neutral · R reject · E edit times · ↓/↑ move focus. */
export function keyToAction(key: string): ReviewAction | null {
  return KEYS[key.length === 1 ? key.toLowerCase() : key] ?? null;
}

const hidden = (c: ReviewClip) => c.status === "neutral" || c.status === "rejected";

function matches(c: ReviewClip, f: ReviewFilter): boolean {
  switch (f) {
    case "all":
      return !hidden(c);
    case "approved":
    case "neutral":
    case "rejected": // rejecting is reversible from here
      return c.status === f;
    default:
      return c.label === f && !hidden(c);
  }
}

/**
 * Clips the filter shows, as a tree. A parent stays with its matching hot takes; a matching hot take
 * whose parent is filtered out is shown on its own, in the parent's place. `all` hides neutral and rejected.
 */
export function filterClips<T extends ReviewClip>(tree: ClipNode<T>[], f: ReviewFilter): ClipNode<T>[] {
  const out: ClipNode<T>[] = [];
  for (const parent of tree) {
    const kids = parent.children.filter((c) => matches(c, f));
    if (matches(parent, f)) out.push({ ...parent, children: kids });
    else out.push(...kids.map((k) => ({ ...k, children: [] })));
  }
  return out;
}

/** Number of clips (parents and hot takes) each filter chip shows. */
export function countByFilter(tree: ClipNode[]): Record<ReviewFilter, number> {
  const counts = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<ReviewFilter, number>;
  for (const c of flattenTree(tree)) for (const f of FILTERS) if (matches(c, f)) counts[f] += 1;
  return counts;
}

/** Display / keyboard order: each parent followed by its hot takes. */
export function flattenTree<T extends ReviewClip>(tree: ClipNode<T>[]): T[] {
  return tree.flatMap(({ children, ...parent }) => [parent as unknown as T, ...children]);
}

/**
 * Groups rows (in `listClips` order: parents by score, children by start) into `{ ...parent, children }`.
 * A child whose parent is not among the rows is kept as a top-level node.
 */
export function buildClipTree<T extends Pick<ReviewClip, "id" | "parentId">>(rows: T[]): (T & { children: T[] })[] {
  const ids = new Set(rows.map((r) => r.id));
  const nodes = new Map<string, T & { children: T[] }>();
  const out: (T & { children: T[] })[] = [];
  for (const r of rows) {
    if (r.parentId !== null && ids.has(r.parentId)) continue;
    const n = { ...r, children: [] as T[] };
    nodes.set(r.id, n);
    out.push(n);
  }
  for (const r of rows) {
    if (r.parentId === null || !ids.has(r.parentId)) continue;
    const parent = nodes.get(r.parentId);
    if (parent) parent.children.push(r);
    else out.push({ ...r, children: [] }); // nested deeper than one level: never dropped
  }
  return out;
}

/** Card duration badge: `m:ss`, or `h:mm:ss` from one hour. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
