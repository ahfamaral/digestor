ALTER TABLE "clips" ADD COLUMN "subtitle_style" text DEFAULT 'yellow' NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "subtitle_position" text DEFAULT 'bottom' NOT NULL;--> statement-breakpoint
UPDATE "clips" c SET "subtitle_position" = 'above_banner' FROM "sessions" s
  WHERE s.id = c.session_id AND s.profile IN ('parliament','supreme_court','trial','un');--> statement-breakpoint
UPDATE "subtitle_tracks" SET "burn_status" = 'stale' WHERE "burn_status" = 'done';
