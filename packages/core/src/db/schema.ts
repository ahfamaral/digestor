import {
  boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import type { AnalysisStatus, BriefingContent, MomentChecks, MomentOrigin, HighlightMethod } from "../analysisTypes.ts";
import type {
  AskActionKind, AskActionStatus, AskMessageStatus, AskRole, ClipActor, ClipEventKind, ClipFormat, ProblemTargetKind,
  RenderStatus, SelectionStatus, TrackCue, TrackStatus,
} from "../personalTypes.ts";
import type { Granularity, HighlightTypeId } from "../profiles.ts";
import type { ContextCard, Stage, Word } from "../schemas.ts";

export type { Stage };

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  source: text("source", { enum: ["upload", "youtube"] }).notNull(),
  sourceUrl: text("source_url"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  originalKey: text("original_key"),
  audioKey: text("audio_key"),
  proxyKey: text("proxy_key"),
  durationMs: integer("duration_ms"),
  language: text("language"),
  profile: text("profile"),
  hint: text("hint"),
  stage: text("stage").$type<Stage>().notNull().default("uploaded"),
  progress: integer("progress").notNull().default(0),
  error: text("error"),
  ownerId: text("owner_id").notNull().default("owner"),
  hasVideo: boolean("has_video").notNull().default(true),
  audioOnlyAck: boolean("audio_only_ack").notNull().default(false),
  videoDeletedAt: timestamp("video_deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transcripts = pgTable("transcripts", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  language: text("language").notNull(),
  languageConfidence: doublePrecision("language_confidence").notNull(),
  durationMs: integer("duration_ms").notNull(),
  words: jsonb("words").$type<Word[]>().notNull(),
});

export const contextCards = pgTable("context_cards", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  card: jsonb("card").$type<ContextCard>().notNull(),
  round: integer("round").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const analysisVersions = pgTable(
  "analysis_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<AnalysisStatus>().notNull().default("running"),
    profile: text("profile").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),
    models: jsonb("models").$type<Record<string, string>>().notNull().default({}),
    promptVersions: jsonb("prompt_versions").$type<Record<string, string>>().notNull().default({}),
    reason: text("reason").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("analysis_versions_session_version").on(t.sessionId, t.version)],
);

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analysisVersions.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
  },
  (t) => [index("topics_analysis_idx").on(t.analysisId)],
);

export const moments = pgTable(
  "moments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analysisVersions.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),
    granularity: text("granularity").$type<Granularity>().notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    title: text("title").notNull(),
    why: text("why").notNull(),
    relevance: integer("relevance").notNull(),
    speakers: text("speakers").array().notNull().default([]),
    insideMomentId: uuid("inside_moment_id"),
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    checks: jsonb("checks").$type<MomentChecks>(),
    /** When a `moment.check` job was last claimed (claimMomentCheck); null = never, or released after a failure. */
    checksRequestedAt: timestamp("checks_requested_at", { withTimezone: true }),
    thumbKey: text("thumb_key"),
    ownerId: text("owner_id"),
    origin: text("origin").$type<MomentOrigin>().notNull().default("ai"),
  },
  (t) => [index("moments_analysis_idx").on(t.analysisId)],
);

export const momentHighlights = pgTable(
  "moment_highlights",
  {
    momentId: uuid("moment_id")
      .notNull()
      .references(() => moments.id, { onDelete: "cascade" }),
    type: text("type").$type<HighlightTypeId>().notNull(),
    method: text("method").$type<HighlightMethod>().notNull(),
    value: doublePrecision("value"),
  },
  (t) => [primaryKey({ columns: [t.momentId, t.type] })],
);

export const briefings = pgTable("briefings", {
  analysisId: uuid("analysis_id")
    .primaryKey()
    .references(() => analysisVersions.id, { onDelete: "cascade" }),
  lead: jsonb("lead").$type<BriefingContent["lead"]>().notNull(),
  sections: jsonb("sections").$type<BriefingContent["sections"]>().notNull(),
});

export const translations = pgTable(
  "translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analysisVersions.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    kind: text("kind").$type<"briefing">().notNull(),
    /** null while `pending` or `failed`. */
    content: jsonb("content").$type<unknown>(),
    status: text("status").$type<"pending" | "ready" | "failed">().notNull().default("ready"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("translations_analysis_language_kind").on(t.analysisId, t.language, t.kind)],
);

export const selections = pgTable(
  "selections",
  {
    ownerId: text("owner_id").notNull(),
    momentId: uuid("moment_id")
      .notNull()
      .references(() => moments.id, { onDelete: "cascade" }),
    status: text("status").$type<SelectionStatus>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.momentId] })],
);

export const clips = pgTable(
  "clips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    momentId: uuid("moment_id").references(() => moments.id, { onDelete: "set null" }),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    format: text("format").$type<ClipFormat>().notNull().default("16:9"),
    cropOffset: doublePrecision("crop_offset").notNull().default(0),
    credit: text("credit"),
    noCreditNeeded: boolean("no_credit_needed").notNull().default(false),
    warningsAck: boolean("warnings_ack").notNull().default(false),
    protectedAck: boolean("protected_ack").notNull().default(false),
    renderStatus: text("render_status").$type<RenderStatus>().notNull().default("none"),
    renderKey: text("render_key"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("clips_owner_session_idx").on(t.ownerId, t.sessionId)],
);

export const clipEvents = pgTable("clip_events", {
  id: serial("id").primaryKey(),
  clipId: uuid("clip_id")
    .notNull()
    .references(() => clips.id, { onDelete: "cascade" }),
  actor: text("actor").$type<ClipActor>().notNull(),
  kind: text("kind").$type<ClipEventKind>().notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const subtitleTracks = pgTable(
  "subtitle_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id")
      .notNull()
      .references(() => clips.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    status: text("status").$type<TrackStatus>().notNull().default("preparing"),
    cues: jsonb("cues").$type<TrackCue[]>().notNull().default([]),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    burnStatus: text("burn_status").$type<RenderStatus>().notNull().default("none"),
    burnKey: text("burn_key"),
    srtKey: text("srt_key"),
    vttKey: text("vtt_key"),
    error: text("error"),
    /** The clip range the cues were built for (cues are clip-relative); null until prepared. */
    builtStartMs: integer("built_start_ms"),
    builtEndMs: integer("built_end_ms"),
  },
  (t) => [unique("subtitle_tracks_clip_language").on(t.clipId, t.language)],
);

export const askMessages = pgTable(
  "ask_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    role: text("role").$type<AskRole>().notNull(),
    text: text("text").notNull().default(""),
    toolCalls: jsonb("tool_calls").$type<unknown>(),
    status: text("status").$type<AskMessageStatus>().notNull().default("done"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ask_messages_owner_session_idx").on(t.ownerId, t.sessionId)],
);

export const askActions = pgTable("ask_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => askMessages.id, { onDelete: "cascade" }),
  kind: text("kind").$type<AskActionKind>().notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  status: text("status").$type<AskActionStatus>().notNull().default("pending"),
});

export const problemReports = pgTable("problem_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  targetKind: text("target_kind").$type<ProblemTargetKind>().notNull(),
  targetId: text("target_id").notNull(),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
