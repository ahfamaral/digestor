// Client-safe row shapes of the personal layer (Ruling R3). `db/personal.ts` returns these.
import type { SubtitlePosition, SubtitleStyle } from "./subtitleStyle.ts";

export type SelectionStatus = "approved" | "rejected";
export type ClipFormat = "16:9" | "9:16";
export type RenderStatus = "none" | "queued" | "rendering" | "done" | "failed" | "stale";
export type ClipActor = "user" | "ask";
export type ClipEventKind = "create" | "bounds" | "format" | "style" | "delete" | "merge";
/** `outdated`: built for clip bounds that have since changed (Rebuild replaces it). */
export type TrackStatus = "preparing" | "ready" | "failed" | "outdated";
export type AskRole = "user" | "assistant";
/** `running`: a worker claimed it (claimAskMessage); the UI treats it like `pending`. */
export type AskMessageStatus = "pending" | "running" | "done" | "failed";
export type AskActionKind = "bulk_selection";
export type AskActionStatus = "pending" | "confirmed" | "dismissed";
export type ProblemTargetKind = "moment" | "topic" | "briefing" | "quote" | "clip" | "track" | "attribution";

export interface TrackCue {
  startMs: number;
  endMs: number;
  original: string;
  text: string;
  missing: boolean;
}

export interface Clip {
  id: string;
  sessionId: string;
  ownerId: string;
  momentId: string | null;
  /** Moments absorbed by merges (not the clip's own `momentId`). */
  mergedMomentIds: string[];
  startMs: number;
  endMs: number;
  format: ClipFormat;
  /** -1…1 */
  cropOffset: number;
  subtitleStyle: SubtitleStyle;
  subtitlePosition: SubtitlePosition;
  credit: string | null;
  noCreditNeeded: boolean;
  warningsAck: boolean;
  protectedAck: boolean;
  renderStatus: RenderStatus;
  renderKey: string | null;
  /** Set when the clip was deleted (or its creation undone); the row and its history are kept. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClipEvent {
  id: number;
  clipId: string;
  actor: ClipActor;
  kind: ClipEventKind;
  before: unknown;
  after: unknown;
  undoneAt: Date | null;
  at: Date;
}

export interface Track {
  id: string;
  clipId: string;
  language: string;
  status: TrackStatus;
  cues: TrackCue[];
  approvedAt: Date | null;
  burnStatus: RenderStatus;
  burnKey: string | null;
  srtKey: string | null;
  vttKey: string | null;
  error: string | null;
  /** The clip range the cues were built for; null until prepared. */
  builtStartMs: number | null;
  builtEndMs: number | null;
}

export interface AskAction {
  id: string;
  messageId: string;
  kind: AskActionKind;
  payload: unknown;
  status: AskActionStatus;
}

export interface AskMessage {
  id: string;
  sessionId: string;
  ownerId: string;
  role: AskRole;
  text: string;
  toolCalls: unknown;
  status: AskMessageStatus;
  createdAt: Date;
}

/** One tool call of an Ask answer, as stored in `ask_messages.tool_calls` (the UI's chips). */
export interface AskToolCallRecord {
  name: string;
  /** The model's arguments (a string preview when very large or unparseable). */
  args: unknown;
  /** Short result text shown on the chip. */
  result: string;
  ok: boolean;
  /** set_selection applied directly: each moment's status before the change (null = proposed, no row). */
  undo?: Record<string, SelectionStatus | null>;
  /** propose_clip: the clip it created (undo deletes it). */
  clipId?: string;
}

export type AskMessageWithActions = AskMessage & { actions: AskAction[] };

export interface ProblemReport {
  id: string;
  ownerId: string;
  sessionId: string;
  targetKind: ProblemTargetKind;
  targetId: string;
  note: string;
  createdAt: Date;
}

export type FindMoreStatus = "pending" | "running" | "done" | "failed";

/** One "Find more moments with <person>" run for an analysis version. */
export interface FindMoreRequest {
  id: string;
  ownerId: string;
  analysisId: string;
  personId: string;
  status: FindMoreStatus;
  error: string | null;
  momentCount: number;
  createdAt: Date;
  updatedAt: Date;
}
