ALTER TABLE "clips" ADD COLUMN "edit_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "goal" text;