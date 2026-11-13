import {
  type AnyPgColumn, boolean, check, customType, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, real, serial, text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AttributionEvidence, AttributionSource, AttributionStatus } from "../attribution.ts";
import type { AnalysisStatus, BriefingContent, LLMUsage, MomentChecks, MomentOrigin, HighlightMethod } from "../analysisTypes.ts";
import type {
  AskActionKind, AskActionStatus, AskMessageStatus, AskRole, ClipActor, ClipEventKind, ClipFormat, ProblemTargetKind,
  FindMoreStatus, LibraryAskSource, LibraryAskStatus, RenderStatus, SelectionStatus, TrackCue, TrackStatus,
} from "../personalTypes.ts";
import type { RecordRef, RecordStatus } from "../recordRef.ts";
import type { ExternalMandate, Position } from "../monitorTimeline.ts";
import type { Granularity, HighlightTypeId } from "../profiles.ts";
import type { SubtitlePosition, SubtitleStyle } from "../subtitleStyle.ts";
import { PIPELINE_STEPS, type ContextCard, type PipelineStep, type ProxyStatus, type Stage, type Word } from "../schemas.ts";

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
  proxyStatus: text("proxy_status").$type<ProxyStatus>(),
  durationMs: integer("duration_ms"),
  language: text("language"),
  profile: text("profile"),
  hint: text("hint"),
  languageOverride: text("language_override"),
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
    /** Tokens and US$ per served model of the run that completed this version (`LLMUsage`). */
    usage: jsonb("usage").$type<LLMUsage>().notNull().default({}),
    reason: text("reason").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    /** When the session's names stood as this version's text was written (Plan 3 §5.2). */
    namesAt: timestamp("names_at", { withTimezone: true }).notNull().defaultNow(),
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
    /** Set on `find_more` moments: the request that made them (a new run replaces them). */
    findMoreRequestId: uuid("find_more_request_id").references(() => findMoreRequests.id, { onDelete: "cascade" }),
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
    /** Last change (request, result, failure): the sweep fails a `pending` row untouched for 30 min with no live job. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
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
    mergedMomentIds: uuid("merged_moment_ids").array().notNull().default(sql`'{}'::uuid[]`),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    format: text("format").$type<ClipFormat>().notNull().default("16:9"),
    cropOffset: doublePrecision("crop_offset").notNull().default(0),
    subtitleStyle: text("subtitle_style").$type<SubtitleStyle>().notNull().default("yellow"),
    subtitlePosition: text("subtitle_position").$type<SubtitlePosition>().notNull().default("bottom"),
    credit: text("credit"),
    /** When the credit line last changed (render writes bump updated_at, so that can't say which credit was typed last). */
    creditSetAt: timestamp("credit_set_at", { withTimezone: true }),
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
    /** Last change to the row: the sweep fails a `preparing` track or a queued/rendering burn untouched for 30 min with no live job. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
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
    /** Last status change: the drawer gives up on an answer that has been `pending`/`running` this long (a resumed answer is fresh). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("ask_messages_owner_session_idx").on(t.ownerId, t.sessionId)],
);

export const askActions = pgTable(
  "ask_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => askMessages.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AskActionKind>().notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    status: text("status").$type<AskActionStatus>().notNull().default("pending"),
    /** `tool_approval`: the journalist's decision (`ToolApprovalResolution`), stored with the status change. */
    resolution: jsonb("resolution").$type<unknown>(),
  },
  // One approval per answer and model turn: the graph's approve node re-runs on resume and finds it.
  (t) => [uniqueIndex("ask_actions_tool_approval_step").on(t.messageId, sql`(${t.payload}->>'step')`).where(sql`${t.kind} = 'tool_approval'`)],
);

/**
 * Ask across videos: one conversation per owner over every searchable video. Read-only (no actions, no pause); the
 * sources a reply searched are stored with it, so a source whose session was deleted later still renders as text.
 */
export const libraryAskMessages = pgTable(
  "library_ask_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    role: text("role").$type<AskRole>().notNull(),
    /** An answer's question (set when both are stored together), so two questions sent at once never swap answers. */
    questionId: uuid("question_id").references((): AnyPgColumn => libraryAskMessages.id, { onDelete: "cascade" }),
    text: text("text").notNull().default(""),
    sources: jsonb("sources").$type<LibraryAskSource[]>(),
    toolCalls: jsonb("tool_calls").$type<unknown>(),
    status: text("status").$type<LibraryAskStatus>().notNull().default("done"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last status change: the sweep ages `pending`/`running` rows by it (R32). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("library_ask_messages_owner_idx").on(t.ownerId, t.createdAt)],
);

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

export const persons = pgTable(
  "persons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    fullName: text("full_name"),
    kind: text("kind", { enum: ["official", "custom"] }).notNull(),
    party: text("party"),
    state: text("state"),
    role: text("role"),
    photoUrl: text("photo_url"),
    officialIds: jsonb("official_ids").$type<Record<string, string>>().notNull().default({}),
    /** normaliseName(displayName + " " + fullName), for search. */
    nameNorm: text("name_norm").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("persons_official_senado").on(sql`(${t.officialIds}->>'senado')`),
    uniqueIndex("persons_official_camara").on(sql`(${t.officialIds}->>'camara')`),
    uniqueIndex("persons_official_bundestag").on(sql`(${t.officialIds}->>'bundestag')`),
    uniqueIndex("persons_official_bioguide").on(sql`(${t.officialIds}->>'bioguide')`),
    index("persons_name_norm").on(t.nameNorm),
  ],
);

/** "Find more moments with <person>" (one per owner, analysis version and person): a paid job over that person's turns. */
export const findMoreRequests = pgTable(
  "find_more_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analysisVersions.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    status: text("status").$type<FindMoreStatus>().notNull().default("pending"),
    error: text("error"),
    momentCount: integer("moment_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last change: the sweep fails a `pending`/`running` row untouched for 30 min with no live job. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("find_more_owner_analysis_person").on(t.ownerId, t.analysisId, t.personId)],
);

export const attributions = pgTable(
  "attributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    speakerId: text("speaker_id").notNull(),
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),
    personId: uuid("person_id").references(() => persons.id),
    source: text("source").$type<AttributionSource>().notNull(),
    status: text("status").$type<AttributionStatus>().notNull(),
    confidence: doublePrecision("confidence").notNull(),
    evidence: jsonb("evidence").$type<AttributionEvidence>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [index("attributions_session_speaker").on(t.sessionId, t.speakerId)],
);

/** The official record linked to a session (at most one): the Senado/Câmara speeches the names are matched against. */
export const sessionRecords = pgTable("session_records", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  chamber: text("chamber", { enum: ["senado", "camara", "bundestag", "us_house", "us_senate"] }).notNull(),
  ref: jsonb("ref").$type<RecordRef>().notNull(),
  status: text("status").$type<RecordStatus>().notNull().default("pending"),
  /** A friendly sentence when `failed`. */
  error: text("error"),
  /** Storage key of the raw payload (`<sessionId>/names/record.json`) once matched. */
  rawKey: text("raw_key"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  /** When a `waiting` record is next fetched (the hourly `records.retry` job); null otherwise. */
  retryAt: timestamp("retry_at", { withTimezone: true }),
  /** When the current ref was linked: changes only when the ref changes (a re-link of the same ref keeps it). */
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last change: the sweep fails a `pending`/`running` row untouched for 30 min with no live job. */
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

/** Where a session's upload pipeline stands: the step still to run, the context-check round and the journalist's answers. */
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    nextStep: text("next_step").$type<PipelineStep>().notNull(),
    round: integer("round").notNull().default(0),
    answers: jsonb("answers").$type<{ question: string; answer: string }[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("pipeline_runs_next_step_check", sql`${t.nextStep} IN (${sql.join(PIPELINE_STEPS.map((s) => sql.raw(`'${s}'`)), sql`, `)})`),
  ],
);

// ── Parliament monitor (Câmara preview, migration 0022) ──────────────────────────────────────────────────────────────
// Official records only. `pt_unaccent` is a copy of Postgres' `portuguese` text-search configuration with `unaccent`
// first, created by hand at the top of 0022, so "feminicidio" matches "feminicídios".

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const parlMembers = pgTable(
  "parl_members",
  {
    id: serial("id").primaryKey(),
    /** Only "camara" for now; the column lets another house be added later. */
    house: text("house").$type<"camara">().notNull(),
    externalId: integer("external_id").notNull(),
    name: text("name").notNull(),
    /** Lower-case, accents stripped in code (`normName`): the name search runs on it. */
    nameNorm: text("name_norm").notNull(),
    party: text("party"),
    uf: text("uf"),
    photoUrl: text("photo_url"),
    /** In `GET /deputados` today; false shows "Not in office now". */
    inOffice: boolean("in_office").notNull().default(false),
    /** Profile, refreshed weekly (`/profissoes`, `/mandatosExternos`, `/frentes`, `/orgaos`); null until first fetched. */
    profession: text("profession"),
    externalMandates: jsonb("external_mandates").$type<ExternalMandate[]>(),
    fronts: jsonb("fronts").$type<string[]>(),
    positions: jsonb("positions").$type<Position[]>(),
    profileRefreshedAt: timestamp("profile_refreshed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    unique("parl_members_house_external_id_unique").on(t.house, t.externalId),
    index("parl_members_name_norm_trgm").using("gin", sql`${t.nameNorm} gin_trgm_ops`),
  ],
);

export const parlSpeeches = pgTable(
  "parl_speeches",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => parlMembers.id, { onDelete: "cascade" }),
    /** Brasília local time as published (no zone); a 4-minute stenography block. */
    startsAt: timestamp("starts_at", { mode: "string" }).notNull(),
    phase: text("phase"),
    kind: text("kind"),
    summary: text("summary").notNull().default(""),
    /** Full official text; empty until the Câmara publishes the transcription. */
    text: text("text").notNull().default(""),
    keywords: text("keywords").notNull().default(""),
    /** The Câmara's page for the speech's text in the Diário (`urlTexto`), https on a Câmara host only; else null. */
    urlText: text("url_text"),
    /**
     * The Câmara published the speech as an attached file (a .docx's bytes inside `transcricao`): `text` then holds only
     * the heading before it, and the full text is only in the official record.
     */
    textFile: boolean("text_file").notNull().default(false),
    /** `{externalId}:{startsAt}:{text fingerprint}`: survives the nightly window replace (a later video link points here). */
    speechKey: text("speech_key"),
    /** The speaker's party and state on the day (`fillSpeechParties`, from the history); null without history. */
    party: text("party"),
    uf: text("uf"),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`setweight(to_tsvector('pt_unaccent', summary || ' ' || keywords), 'A') || setweight(to_tsvector('pt_unaccent', text), 'B')`,
    ),
  },
  (t) => [
    index("parl_speeches_member_starts").on(t.memberId, t.startsAt),
    index("parl_speeches_tsv").using("gin", t.tsv),
    uniqueIndex("parl_speeches_key").on(t.speechKey),
  ],
);

export const parlRollCalls = pgTable(
  "parl_roll_calls",
  {
    /** The votação id, e.g. "2449741-72". */
    id: text("id").primaryKey(),
    house: text("house").$type<"camara">().notNull(),
    date: date("date", { mode: "string" }).notNull(),
    registeredAt: timestamp("registered_at", { mode: "string" }),
    description: text("description").notNull(),
    yes: integer("yes").notNull(),
    no: integer("no").notNull(),
    other: integer("other").notNull(),
    billId: integer("bill_id"),
    /** e.g. "PL 3880/2024". */
    billLabel: text("bill_label"),
    billSummary: text("bill_summary").notNull().default(""),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`setweight(to_tsvector('pt_unaccent', bill_summary), 'A') || setweight(to_tsvector('pt_unaccent', description), 'B')`,
    ),
  },
  (t) => [index("parl_roll_calls_tsv").using("gin", t.tsv), index("parl_roll_calls_date").on(t.date)],
);

export const parlVotes = pgTable(
  "parl_votes",
  {
    rollCallId: text("roll_call_id")
      .notNull()
      .references(() => parlRollCalls.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => parlMembers.id, { onDelete: "cascade" }),
    /** As published: Sim, Não, Abstenção, Obstrução, Art. 17. */
    vote: text("vote").notNull(),
    /** Party and state on the vote row (at the time of the vote). */
    party: text("party"),
    uf: text("uf"),
  },
  (t) => [primaryKey({ columns: [t.rollCallId, t.memberId] }), index("parl_votes_member").on(t.memberId)],
);

/** `/deputados/{id}/historico`, replaced per deputy each night. */
export const parlMemberHistory = pgTable(
  "parl_member_history",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => parlMembers.id, { onDelete: "cascade" }),
    at: timestamp("at", { mode: "string" }).notNull(),
    party: text("party"),
    uf: text("uf"),
    /** `situacao`: "Exercício" means in office. */
    status: text("status"),
    description: text("description").notNull().default(""),
  },
  (t) => [index("parl_member_history_member_at").on(t.memberId, t.at)],
);

/** Party, bloc and government guidance per roll call (`votacoesOrientacoes-*.csv`), as published. */
export const parlOrientations = pgTable(
  "parl_orientations",
  {
    rollCallId: text("roll_call_id")
      .notNull()
      .references(() => parlRollCalls.id, { onDelete: "cascade" }),
    bloc: text("bloc").notNull(),
    orientation: text("orientation").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.rollCallId, t.bloc] })],
);

/** Bills and requests presented since `MONITOR_FROM` (`proposicoes-*.csv`). */
export const parlBills = pgTable(
  "parl_bills",
  {
    id: integer("id").primaryKey(),
    house: text("house").$type<"camara">().notNull(),
    type: text("type").notNull(),
    number: integer("number").notNull(),
    year: integer("year").notNull(),
    summary: text("summary").notNull().default(""),
    presentedAt: timestamp("presented_at", { mode: "string" }).notNull(),
  },
  (t) => [index("parl_bills_presented_at").on(t.presentedAt)],
);

/** Deputies who signed a bill (`proposicoesAutores-*.csv`); `firstAuthor` = signature order 1. */
export const parlBillAuthors = pgTable(
  "parl_bill_authors",
  {
    billId: integer("bill_id")
      .notNull()
      .references(() => parlBills.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => parlMembers.id, { onDelete: "cascade" }),
    firstAuthor: boolean("first_author").notNull(),
  },
  (t) => [primaryKey({ columns: [t.billId, t.memberId] }), index("parl_bill_authors_member").on(t.memberId)],
);

/** Plenary deliberative sessions ("Sessão Deliberativa" events, `eventos-*.csv`), any status. */
export const parlSessions = pgTable("parl_sessions", {
  id: integer("id").primaryKey(),
  house: text("house").$type<"camara">().notNull(),
  startsAt: timestamp("starts_at", { mode: "string" }).notNull(),
  description: text("description").notNull(),
  /** `situacao`: "Encerrada" when held. */
  status: text("status").notNull(),
});

/**
 * The official video of a plenary session (the event's `urlRegistro`, a YouTube link on the Câmara's channel) and the
 * state of matching its speeches to the video's automatic captions (`monitor.video`). Rows are claimed with
 * compare-and-set (`claimSessionVideo`): `pending` (or `running` untouched for 30 min) → `running` → `done`, `no_video`
 * (the event has no link yet; looked at again later), `no_captions` or `failed`. `stream_start` is the stream's start in
 * Brasília local time (no zone, like `parl_speeches.starts_at`): the anchor for each speech's 4-minute stamp.
 */
export const parlSessionVideos = pgTable("parl_session_videos", {
  sessionId: integer("session_id")
    .primaryKey()
    .references(() => parlSessions.id, { onDelete: "cascade" }),
  videoId: text("video_id"),
  streamStart: timestamp("stream_start", { mode: "string" }),
  durationS: integer("duration_s"),
  status: text("status").$type<"pending" | "running" | "done" | "no_video" | "no_captions" | "failed">().notNull().default("pending"),
  /** Speeches with text in the session's range at the last run, and how many got a video moment. */
  spoken: integer("spoken").notNull().default(0),
  matched: integer("matched").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  /** When the row may be claimed again (a `no_video` / `failed` row waits; a `done` row is re-run when new texts arrive). */
  retryAt: timestamp("retry_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Where a speech is in its session's video: seconds from the video's start, and the match score (cosine of the speech's
 * words against the captions between start and end). Keyed by `parl_speeches.speech_key`, which survives the nightly
 * window replace. Only matches at or above `VIDEO_MATCH_MIN` are stored.
 */
export const parlSpeechVideos = pgTable(
  "parl_speech_videos",
  {
    speechKey: text("speech_key").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => parlSessions.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    startS: integer("start_s").notNull(),
    endS: integer("end_s").notNull(),
    score: real("score").notNull(),
    alignedAt: timestamp("aligned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("parl_speech_videos_session").on(t.sessionId)],
);

/** A recorded presence of a deputy at a session (`eventosPresencaDeputados-*.csv`). */
export const parlPresence = pgTable(
  "parl_presence",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => parlSessions.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => parlMembers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.memberId] }), index("parl_presence_member").on(t.memberId)],
);

/**
 * Word counts of the speeches' official text for "Words used more than the chamber" (`refreshWordCounts`, rebuilt after
 * each nightly speech refresh): per deputy, party on the day (`''` when unknown) and month, each stem of
 * `to_tsvector('pt_unaccent', text)` (speaker headers and the stoplist left out) and how many times it was said.
 */
export const parlWordCounts = pgTable(
  "parl_word_counts",
  {
    memberId: integer("member_id")
      .notNull()
      .references(() => parlMembers.id, { onDelete: "cascade" }),
    party: text("party").notNull().default(""),
    /** First day of the month (the speech's Brasília date). */
    month: date("month", { mode: "string" }).notNull(),
    stem: text("stem").notNull(),
    n: integer("n").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.party, t.month, t.stem] }),
    index("parl_word_counts_party").on(t.party),
    index("parl_word_counts_stem").on(t.stem),
  ],
);

/**
 * Speeches in the meaning index (Chroma collection `monitor_camara_speeches`, `embedSpeeches` in the worker): one row
 * per speech key whose chunks are stored there. A key no speech has any more (a revised text gets a new key) has its
 * chunks deleted and its row removed on the next run.
 */
export const parlSpeechEmbeddings = pgTable("parl_speech_embeddings", {
  speechKey: text("speech_key").primaryKey(),
  chunks: integer("chunks").notNull(),
  embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
});
