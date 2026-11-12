CREATE TABLE "parl_session_videos" (
	"session_id" integer PRIMARY KEY NOT NULL,
	"video_id" text,
	"stream_start" timestamp,
	"duration_s" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"spoken" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"retry_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parl_speech_videos" (
	"speech_key" text PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"video_id" text NOT NULL,
	"start_s" integer NOT NULL,
	"end_s" integer NOT NULL,
	"score" real NOT NULL,
	"aligned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parl_session_videos" ADD CONSTRAINT "parl_session_videos_session_id_parl_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."parl_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_speech_videos" ADD CONSTRAINT "parl_speech_videos_session_id_parl_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."parl_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parl_speech_videos_session" ON "parl_speech_videos" USING btree ("session_id");