CREATE TABLE "clip_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"clip_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"label" text NOT NULL,
	"score" integer NOT NULL,
	"reason" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"origin" text DEFAULT 'ai' NOT NULL,
	"out_of_bounds" boolean DEFAULT false NOT NULL,
	"thumb_key" text,
	"render_status" text DEFAULT 'none' NOT NULL,
	"render_key" text,
	"srt_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_cards" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"card" jsonb NOT NULL,
	"round" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_key" text,
	"audio_key" text,
	"proxy_key" text,
	"duration_ms" integer,
	"language" text,
	"event_type" text,
	"hint" text,
	"stage" text DEFAULT 'uploaded' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"language" text NOT NULL,
	"language_confidence" double precision NOT NULL,
	"duration_ms" integer NOT NULL,
	"words" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_events" ADD CONSTRAINT "clip_events_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_parent_id_clips_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."clips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_cards" ADD CONSTRAINT "context_cards_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;