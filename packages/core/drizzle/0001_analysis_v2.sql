CREATE TABLE "analysis_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"profile" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_versions_session_version" UNIQUE("session_id","version")
);
--> statement-breakpoint
CREATE TABLE "briefings" (
	"analysis_id" uuid PRIMARY KEY NOT NULL,
	"lead" jsonb NOT NULL,
	"sections" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moment_highlights" (
	"moment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"method" text NOT NULL,
	"value" double precision,
	CONSTRAINT "moment_highlights_moment_id_type_pk" PRIMARY KEY("moment_id","type")
);
--> statement-breakpoint
CREATE TABLE "moments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"topic_id" uuid,
	"granularity" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"title" text NOT NULL,
	"why" text NOT NULL,
	"relevance" integer NOT NULL,
	"speakers" text[] DEFAULT '{}' NOT NULL,
	"inside_moment_id" uuid,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb,
	"thumb_key" text,
	"owner_id" text,
	"origin" text DEFAULT 'ai' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"language" text NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translations_analysis_language_kind" UNIQUE("analysis_id","language","kind")
);
--> statement-breakpoint
DROP TABLE "clip_events" CASCADE;--> statement-breakpoint
DROP TABLE "clips" CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "profile" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "owner_id" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "has_video" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "audio_only_ack" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "video_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_versions" ADD CONSTRAINT "analysis_versions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_analysis_id_analysis_versions_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analysis_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_highlights" ADD CONSTRAINT "moment_highlights_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_analysis_id_analysis_versions_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analysis_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_analysis_id_analysis_versions_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analysis_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_analysis_id_analysis_versions_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analysis_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moments_analysis_idx" ON "moments" USING btree ("analysis_id");--> statement-breakpoint
CREATE INDEX "topics_analysis_idx" ON "topics" USING btree ("analysis_id");--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "event_type";