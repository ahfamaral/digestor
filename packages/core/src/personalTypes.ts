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
/**
 * `running`: a worker claimed it (claimAskMessage); the UI treats it like `pending`. `waiting`: paused until the
 * journalist approves, edits or rejects a change (a `tool_approval` action); no job owns it, the sweep leaves it.
 */
export type AskMessageStatus = "pending" | "running" | "waiting" | "done" | "failed";
export type AskActionKind = "bulk_selection" | "tool_approval";
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
  /** When the credit line last changed. */
  creditSetAt: Date | null;
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
  /** `tool_approval` only, once decided: a `ToolApprovalResolution`. */
  resolution: unknown;
}

/**
 * One change Ask wants to make, waiting for approval. For the card's Edit: `range` is a clip call's range after
 * snapping (what `summary` shows), `moments` a `set_selection` call's moments.
 */
export interface ToolApprovalCall {
  id: string;
  name: string;
  args: unknown;
  summary: string;
  range?: { startMs: number; endMs: number };
  moments?: { id: string; title: string; startMs: number; endMs: number }[];
  /** A `make_clip_package` call: its clips after snapping, the format and the subtitle language, for the card's picks. */
  package?: ClipPackagePlan;
}

/** What a clip package will make: the clips (snapped), one format for all, and subtitle drafts in one language or none. */
export interface ClipPackagePlan {
  clips: { startMs: number; endMs: number; title: string }[];
  format: ClipFormat;
  subtitles: string | null;
}

/** Payload of a `tool_approval` action: the changes of one model turn (`step`). */
export interface ToolApprovalPayload {
  step: number;
  calls: ToolApprovalCall[];
}

export type ToolApprovalDecision = "approve" | "reject" | "edit";

/** What the journalist decided; `edits` replaces the arguments of the listed calls (only with "edit"). */
export interface ToolApprovalResolution {
  decision: ToolApprovalDecision;
  edits?: { id: string; args: unknown }[];
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
  updatedAt: Date;
}

/** One tool call of an Ask answer, as stored in `ask_messages.tool_calls` (the UI's chips). */
export interface AskToolCallRecord {
  name: string;
  /** The model's arguments (a string preview when very large or unparseable). */
  args: unknown;
  /** Short result text shown on the chip. */
  result: string;
  ok: boolean;
  /** set_selection, once approved: each moment's status before the change (null = proposed, no row). */
  undo?: Record<string, SelectionStatus | null>;
  /** propose_clip: the clip it created (undo deletes it). */
  clipId?: string;
  /** make_clip_package: the clips it created (undo deletes each). */
  clipIds?: string[];
}

export type AskMessageWithActions = AskMessage & { actions: AskAction[] };

/** Ask across videos (`library_ask_messages`): no approval pause, so never `waiting`. */
export type LibraryAskStatus = Exclude<AskMessageStatus, "waiting">;

/** A video an answer across videos searched, by the label its citations use (`[S2 00:12:03]`). */
export interface LibraryAskSource {
  label: string;
  sessionId: string;
  title: string;
}

/**
 * Why one of the owner's videos wasn't offered to an answer across videos: waiting at the context check, still
 * processing (any stage before `ready`), video removed by retention (`videoDeletedAt`), or ready with no search index
 * (`unavailable`). Failed sessions are never listed.
 */
export type LibraryNotSearchedReason = "awaiting_context" | "processing" | "removed" | "unavailable";

export interface LibraryNotSearchedVideo {
  sessionId: string;
  title: string;
  reason: LibraryNotSearchedReason;
}

/** The owner's videos an answer across videos could not search, as they were when it was answered. */
export interface LibraryNotSearched {
  /** VIDEO_RETENTION_DAYS at answer time, for "older than N days". */
  retentionDays: number;
  videos: LibraryNotSearchedVideo[];
}

export interface LibraryAskMessage {
  id: string;
  ownerId: string;
  role: AskRole;
  /** An answer's question (null on questions, and on answers stored without one). */
  questionId: string | null;
  text: string;
  /** Assistant answers: the videos searched (null on questions and failures). */
  sources: LibraryAskSource[] | null;
  /** The verify chip (`verify_answer`), as on a one-video answer. */
  toolCalls: unknown;
  /** Done answers: the owner's videos that couldn't be searched, and why (null on questions, failures, older rows). */
  notSearched: LibraryNotSearched | null;
  status: LibraryAskStatus;
  createdAt: Date;
  updatedAt: Date;
}

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
