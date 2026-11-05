import type { ClipStatus, SelectionStatus } from "@digestor/core";
import type { MomentView } from "./briefingFilters";

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

/** Clicking the active status returns the moment to undecided (null); anything else sets the clicked status. */
export function nextStatus(current: SelectionStatus | null, clicked: SelectionStatus): SelectionStatus | null {
  return current === clicked ? null : clicked;
}

/** Display order: each moment followed by the moments nested in it. */
export function flattenViews(views: MomentView[]): MomentView[] {
  return views.flatMap((v) => [v, ...flattenViews(v.children)]);
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

/** Whether a keydown opens the Ask drawer (`/`): never while typing, with modifiers, with a dialog open or once handled. */
export function opensAsk(e: Pick<KeyInput, "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented">, ctx: { typing: boolean; dialogOpen: boolean }): boolean {
  return e.key === "/" && !ctx.typing && !ctx.dialogOpen && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey;
}
