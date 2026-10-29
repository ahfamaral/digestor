import { boolean, doublePrecision, integer, jsonb, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ContextCard, Word } from "../schemas.js";

export type Stage =
  | "uploaded"
  | "downloading"
  | "preparing"
  | "transcribing"
  | "understanding"
  | "awaiting_context"
  | "finding_clips"
  | "awaiting_review"
  | "rendering"
  | "done"
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
  eventType: text("event_type"),
  hint: text("hint"),
  stage: text("stage").$type<Stage>().notNull().default("uploaded"),
  progress: integer("progress").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

export const clips = pgTable("clips", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): any => clips.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  label: text("label", { enum: ["heated", "key_point", "light"] }).notNull(),
  score: integer("score").notNull(),
  reason: text("reason").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  status: text("status", { enum: ["proposed", "approved", "neutral", "rejected"] })
    .notNull()
    .default("proposed"),
  origin: text("origin", { enum: ["ai", "user", "copilot"] }).notNull().default("ai"),
  outOfBounds: boolean("out_of_bounds").notNull().default(false),
  thumbKey: text("thumb_key"),
  renderStatus: text("render_status", { enum: ["none", "queued", "rendering", "done", "failed", "stale"] })
    .notNull()
    .default("none"),
  renderKey: text("render_key"),
  srtKey: text("srt_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clipEvents = pgTable("clip_events", {
  id: serial("id").primaryKey(),
  clipId: uuid("clip_id")
    .notNull()
    .references(() => clips.id, { onDelete: "cascade" }),
  actor: text("actor", { enum: ["ai", "user", "copilot"] }).notNull(),
  kind: text("kind", { enum: ["create", "status", "bounds"] }).notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
