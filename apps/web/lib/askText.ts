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

/**
 * A stored or model-written selection status as the current one. Legacy "neutral" and the model's "skipped" are
 * "rejected"; anything unknown is null. Every reader of stored Ask payloads and undo maps goes through this.
 */
export function asSelectionStatus(v: unknown): SelectionStatus | null {
  if (v === "approved") return "approved";
  if (v === "rejected" || v === "neutral" || v === "skipped") return "rejected";
  return null;
}

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
        if (prev === null) undo[id] = null;
        else {
          const status = asSelectionStatus(prev);
          if (status) undo[id] = status;
        }
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

/** The worker stores this many characters of a tool's output (`AskToolCallRecord.result`). */
const STORED_RESULT_CHARS = 300;
const MAX_SOURCE_TITLE = 80;

/** Cuts at the last word boundary within `max` characters and adds "…"; text that fits is returned as is. */
export function cutAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const atSpace = clean[max] === " " ? head : head.slice(0, Math.max(0, head.lastIndexOf(" ")));
  return `${(atSpace || head).trimEnd()}…`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SPAN = /^\[(\d{1,3}:\d{2}(?::\d{2})?)(?:–(\d{1,3}:\d{2}(?::\d{2})?))?\]/;

/** One source line: `text` is a time range (transcript, speech) or text from the recording (moment, topic, note). */
export interface SourceLine {
  kind: "transcript" | "speech" | "moment" | "topic" | "note";
  text: string;
}

/**
 * What a tool call looked at, for the "Sources" list; the drawer words each kind with `t("ask.source.<kind>")`.
 * Calls that changed something (they have Undo) are not sources. No id or tag
 * survives, and no title is cut mid-word.
 */
export function sourceLines(call: AskToolCallRecord): SourceLine[] {
  if (call.ok && (call.clipId !== undefined || call.undo !== undefined)) return [];
  const stored = call.result.length >= STORED_RESULT_CHARS;
  const raw = call.result.replace(/<\/?transcript>/gi, "").replace(UUID, "").replace(/[<>]/g, "");
  const rows = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!call.ok) {
    const text = cutAtWord(raw.replace(/^Error:\s*/i, ""), 120);
    return text ? [{ kind: "note", text }] : [];
  }

  const title = (rest: string, last: boolean) => {
    const [head = "", ...why] = rest.split(" — ");
    // A result cut by storage may end inside its title: drop the broken last word.
    const cut = last && stored && why.length === 0 ? `${head.slice(0, Math.max(0, head.lastIndexOf(" ")))}…` : head;
    return cutAtWord(cut, MAX_SOURCE_TITLE);
  };
  const lines: SourceLine[] = [];
  const stamps: string[] = [];
  rows.forEach((row, i) => {
    const m = SPAN.exec(row);
    if (!m) return;
    const rest = row.slice(m[0].length).trim();
    const last = i === rows.length - 1;
    if (call.name === "get_transcript") stamps.push(m[1]!);
    else if (call.name === "list_moments") {
      // The meta ends with the selection status ("; proposed: Title — why"); a title may hold ": " itself.
      const after = /;\s*(?:proposed|approved|skipped):\s*(.*)$/.exec(rest);
      if (after && m[2]) lines.push({ kind: "moment", text: title(after[1]!, last) });
    } else if (call.name === "list_topics") lines.push({ kind: "topic", text: title(rest, last) });
    else if (m[2]) lines.push({ kind: call.name === "list_speeches" ? "speech" : "transcript", text: `${m[1]}–${m[2]}` });
  });
  if (stamps.length > 0) lines.push({ kind: "transcript", text: stamps.length === 1 || stamps[0] === stamps.at(-1) ? stamps[0]! : `${stamps[0]}–${stamps.at(-1)}` });
  if (lines.length > 0) return [...new Map(lines.map((l) => [`${l.kind}:${l.text}`, l])).values()];
  // Nothing recognisable (no match, a note from the tool): the note itself, in plain words.
  return rows.length > 0 && !rows.some((r) => SPAN.test(r)) ? [{ kind: "note", text: cutAtWord(rows[0]!, 120) }] : [];
}

/** A pending bulk_selection action's payload: which moments, and the status to set (null clears). */
export function parseBulkPayload(raw: unknown): { momentIds: string[]; status: SelectionStatus | null } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { momentIds, status } = raw as { momentIds?: unknown; status?: unknown };
  if (!Array.isArray(momentIds) || !momentIds.every((id) => typeof id === "string")) return null;
  if (status === null) return { momentIds: momentIds as string[], status: null };
  const mapped = asSelectionStatus(status);
  if (!mapped) return null;
  return { momentIds: momentIds as string[], status: mapped };
}

/** Undo of `set_selection` restores only moments still at the status the call set; the rest were changed since. */
export function planSelectionUndo(
  call: AskToolCallRecord,
  current: Record<string, SelectionStatus | undefined>,
): { restore: Record<string, SelectionStatus | null>; skipped: number } {
  const args = call.args as { status?: unknown } | null;
  const raw = typeof args === "object" && args !== null && "status" in args ? args.status : undefined;
  const set = raw === "proposed" || raw === null ? null : (asSelectionStatus(raw) ?? undefined); // the tool's "proposed" is stored as no selection

  const restore: Record<string, SelectionStatus | null> = {};
  let skipped = 0;
  for (const [id, previous] of Object.entries(call.undo ?? {})) {
    if (set !== undefined && (current[id] ?? null) === set) restore[id] = previous;
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
