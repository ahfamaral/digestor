// Client-safe row shapes of the personal layer (Ruling R3). `db/personal.ts` returns these.

export type SelectionStatus = "approved" | "neutral" | "rejected";
export type ClipFormat = "16:9" | "9:16";
export type RenderStatus = "none" | "queued" | "rendering" | "done" | "failed" | "stale";
export type ClipActor = "user" | "ask";
export type ClipEventKind = "create" | "bounds" | "format" | "delete";
export type TrackStatus = "preparing" | "ready" | "failed";
export type AskRole = "user" | "assistant";
export type AskMessageStatus = "pending" | "done" | "failed";
export type AskActionKind = "bulk_selection";
export type AskActionStatus = "pending" | "confirmed" | "dismissed";
export type ProblemTargetKind = "moment" | "topic" | "briefing" | "quote" | "clip" | "track";

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
  startMs: number;
  endMs: number;
  format: ClipFormat;
  /** -1…1 */
  cropOffset: number;
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
