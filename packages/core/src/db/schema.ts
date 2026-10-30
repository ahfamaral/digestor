import {
  boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import type { AnalysisStatus, BriefingContent, MomentChecks, MomentOrigin, HighlightMethod } from "../analysisTypes.ts";
import type { Granularity, HighlightTypeId } from "../profiles.ts";
import type { ContextCard, Word } from "../schemas.ts";

export type Stage =
  | "uploaded"
  | "downloading"
  | "preparing"
  | "transcribing"
  | "understanding"
  | "awaiting_context"
  | "indexing"
  | "finding_topics"
  | "finding_moments"
  | "writing_briefing"
  | "ready"
  | "failed";

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
    content: jsonb("content").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("translations_analysis_language_kind").on(t.analysisId, t.language, t.kind)],
);
