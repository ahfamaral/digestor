import type { ClipStatus, SelectionStatus } from "@digestor/core";
import type { MomentView } from "./briefingFilters";

export type ReviewAction = "approve" | "neutral" | "reject" | "edit" | "next" | "prev";

const KEYS: Record<string, ReviewAction> = {
  a: "approve",
  n: "neutral",
  r: "reject",
  e: "edit",
  ArrowDown: "next",
  ArrowUp: "prev",
};

/** Triage keyboard: A approve · N neutral · R reject · E open in Prepare clips · ↓/↑ move focus. `/` stays free for Ask. */
export function keyToAction(key: string): ReviewAction | null {
  return KEYS[key.length === 1 ? key.toLowerCase() : key] ?? null;
}

/** Where keys belong to the element, not to triage: fields, editable text, media players (arrows seek, space plays) and dialogs. */
export const OWN_KEYS_SELECTOR = "input, textarea, select, video, audio, [role='dialog']";

/** Whether a key event's target keeps its keys (see `OWN_KEYS_SELECTOR`). Takes any event target; non-elements never do. */
export function isTyping(target: unknown): boolean {
  const el = target as { isContentEditable?: unknown; closest?: unknown } | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.isContentEditable === true || (el.closest as (s: string) => unknown).call(el, OWN_KEYS_SELECTOR) !== null;
}

export interface KeyInput {
  key: string;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * The action a keydown triggers, or null when it must be ignored: while typing in a field, while a dialog is open,
 * with Cmd/Ctrl/Alt, or when something already handled it. Holding A/N/R/E must not triage a run of moments, so
 * repeats only count for ↓/↑.
 */
export function actionForKey(e: KeyInput, ctx: { typing: boolean; dialogOpen: boolean }): ReviewAction | null {
  if (ctx.typing || ctx.dialogOpen || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  const action = keyToAction(e.key);
  if (!action) return null;
  if (e.repeat && action !== "next" && action !== "prev") return null;
  return action;
}

export const ACTION_STATUS = { approve: "approved", neutral: "neutral", reject: "rejected" } as const satisfies Record<
  "approve" | "neutral" | "reject",
  SelectionStatus
>;

/** Display and keyboard order: each moment followed by the moments nested in it. */
export function flattenViews(views: MomentView[]): MomentView[] {
  return views.flatMap((v) => [v, ...flattenViews(v.children)]);
}

/** The id one step down (1) or up (-1) from `currentId`, staying inside the list; the first one when nothing is focused. */
export function moveFocus(order: string[], currentId: string | null, dir: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = currentId === null ? -1 : order.indexOf(currentId);
  if (at < 0) return order[0]!;
  return order[Math.min(order.length - 1, Math.max(0, at + dir))]!;
}

/**
 * The focused id in the current list. A moment that left the list (e.g. rejected under "open") hands focus to
 * whatever now sits at its place.
 */
export function resolveFocus(order: string[], focus: { id: string | null; index: number }): string | null {
  if (focus.id !== null && order.includes(focus.id)) return focus.id;
  if (order.length === 0) return null;
  return order[Math.min(Math.max(0, focus.index), order.length - 1)]!;
}

/** Every approved moment (nested or not, shown by the filters or not), by start time: what "Confirm selection" sends. */
export function approvedMomentIds(
  moments: { id: string; startMs: number }[],
  statuses: Record<string, SelectionStatus | null | undefined>,
): string[] {
  return moments
    .filter((m) => statuses[m.id] === "approved")
    .sort((a, b) => a.startMs - b.startMs)
    .map((m) => m.id);
}

/** The status queue speaks `ClipStatus`; no selection row is "proposed". */
export const asClipStatus = (s: SelectionStatus | null): ClipStatus => s ?? "proposed";
export const asSelection = (s: ClipStatus): SelectionStatus | null => (s === "proposed" ? null : s);
