import type { AskToolCallRecord, SelectionStatus } from "@digestor/core";

export type AskTextPart = { kind: "text"; value: string } | { kind: "time"; ms: number; label: string };

// [hh:mm:ss] or [mm:ss]; the groups are checked for range below, so "[75:00]" stays plain text.
const TIMESTAMP = /\[(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\]/g;

/** Splits an answer into plain text and `[hh:mm:ss]` / `[mm:ss]` timestamps (minutes and seconds under 60). */
export function linkifyTimestamps(text: string): AskTextPart[] {
  const parts: AskTextPart[] = [];
  let last = 0;
  const pushText = (end: number) => {
    if (end > last) parts.push({ kind: "text", value: text.slice(last, end) });
  };
  for (const match of text.matchAll(TIMESTAMP)) {
    const hours = match[1] === undefined ? 0 : Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes >= 60 || seconds >= 60) continue;
    const at = match.index;
    pushText(at);
    parts.push({ kind: "time", ms: ((hours * 60 + minutes) * 60 + seconds) * 1000, label: match[0] });
    last = at + match[0].length;
  }
  pushText(text.length);
  return parts;
}

const STATUSES: readonly string[] = ["approved", "neutral", "rejected"];
const isStatus = (v: unknown): v is SelectionStatus => typeof v === "string" && STATUSES.includes(v);

/** The stored tool calls of an answer, keeping only well-formed records (the column is untyped JSON). */
export function asToolCalls(raw: unknown): AskToolCallRecord[] {
  if (!Array.isArray(raw)) return [];
  const calls: AskToolCallRecord[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string") continue;
    const call: AskToolCallRecord = { name: r.name, args: r.args, result: typeof r.result === "string" ? r.result : "", ok: r.ok !== false };
    if (typeof r.undo === "object" && r.undo !== null) {
      const undo: Record<string, SelectionStatus | null> = {};
      for (const [id, prev] of Object.entries(r.undo)) {
        if (prev === null || isStatus(prev)) undo[id] = prev;
      }
      if (Object.keys(undo).length > 0) call.undo = undo;
    }
    if (typeof r.clipId === "string") call.clipId = r.clipId;
    calls.push(call);
  }
  return calls;
}

const MAX_ARGS_CHARS = 60;

function previewValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v);
  return JSON.stringify(v) ?? "";
}

/** `name(key: value, …)` with the arguments cut to a short preview. */
export function formatToolCall(call: AskToolCallRecord): string {
  const { args } = call;
  let inner: string;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    inner = Object.entries(args).map(([k, v]) => `${k}: ${previewValue(v)}`).join(", ");
  } else {
    inner = args === undefined ? "" : previewValue(args);
  }
  inner = inner.replace(/\s+/g, " ").trim();
  if (inner.length > MAX_ARGS_CHARS) inner = `${[...inner].slice(0, MAX_ARGS_CHARS - 1).join("")}…`;
  return `${call.name}(${inner})`;
}

/** A pending bulk_selection action's payload: which moments, and the status to set (null clears). */
export function parseBulkPayload(raw: unknown): { momentIds: string[]; status: SelectionStatus | null } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { momentIds, status } = raw as { momentIds?: unknown; status?: unknown };
  if (!Array.isArray(momentIds) || !momentIds.every((id) => typeof id === "string")) return null;
  if (status !== null && !isStatus(status)) return null;
  return { momentIds: momentIds as string[], status };
}

/** Undo of `set_selection` restores only moments still at the status the call set; the rest were changed since. */
export function planSelectionUndo(
  call: AskToolCallRecord,
  current: Record<string, SelectionStatus | undefined>,
): { restore: Record<string, SelectionStatus | null>; skipped: number } {
  const args = call.args as { status?: unknown } | null;
  const raw = typeof args === "object" && args !== null && "status" in args ? args.status : undefined;
  const set = raw === "proposed" ? null : raw; // the tool's "proposed" is stored as no selection

  const restore: Record<string, SelectionStatus | null> = {};
  let skipped = 0;
  for (const [id, previous] of Object.entries(call.undo ?? {})) {
    if ((set === null || isStatus(set)) && (current[id] ?? null) === set) restore[id] = previous;
    else skipped += 1;
  }
  return { restore, skipped };
}

/** An answer still being worked on: `pending` (queued) or `running` (a worker claimed it). */
export function isAnswering(status: string): boolean {
  return status === "pending" || status === "running";
}

/** A pending answer older than this is given up on (the worker is down or the job was lost). */
export const ASK_PENDING_LIMIT_MS = 3 * 60 * 1000;

export function isStalePending(createdAt: string | Date, now: number): boolean {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) && now - created > ASK_PENDING_LIMIT_MS;
}
