ALTER TABLE "translations" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "translations" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "translations" ADD COLUMN "error" text;