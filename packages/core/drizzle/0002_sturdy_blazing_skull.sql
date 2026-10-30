CREATE TABLE "ask_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ask_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"tool_calls" jsonb,
	"status" text DEFAULT 'done' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"clip_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"undone_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"moment_id" uuid,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"format" text DEFAULT '16:9' NOT NULL,
	"crop_offset" double precision DEFAULT 0 NOT NULL,
	"credit" text,
	"no_credit_needed" boolean DEFAULT false NOT NULL,
	"warnings_ack" boolean DEFAULT false NOT NULL,
	"protected_ack" boolean DEFAULT false NOT NULL,
	"render_status" text DEFAULT 'none' NOT NULL,
	"render_key" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selections" (
	"owner_id" text NOT NULL,
	"moment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selections_owner_id_moment_id_pk" PRIMARY KEY("owner_id","moment_id")
);
--> statement-breakpoint
CREATE TABLE "subtitle_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"language" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"cues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"burn_status" text DEFAULT 'none' NOT NULL,
	"burn_key" text,
	"srt_key" text,
	"vtt_key" text,
	CONSTRAINT "subtitle_tracks_clip_language" UNIQUE("clip_id","language")
);
--> statement-breakpoint
ALTER TABLE "ask_actions" ADD CONSTRAINT "ask_actions_message_id_ask_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ask_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_events" ADD CONSTRAINT "clip_events_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selections" ADD CONSTRAINT "selections_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ADD CONSTRAINT "subtitle_tracks_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_messages_owner_session_idx" ON "ask_messages" USING btree ("owner_id","session_id");--> statement-breakpoint
CREATE INDEX "clips_owner_session_idx" ON "clips" USING btree ("owner_id","session_id");