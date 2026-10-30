ALTER TABLE "moments" ADD COLUMN "checks_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ADD COLUMN "built_start_ms" integer;--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ADD COLUMN "built_end_ms" integer;