ALTER TABLE "session_records" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "linked_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "session_records" SET "linked_at" = "updated_at";--> statement-breakpoint
CREATE UNIQUE INDEX "persons_official_bundestag" ON "persons" USING btree (("official_ids"->>'bundestag'));--> statement-breakpoint
CREATE UNIQUE INDEX "persons_official_bioguide" ON "persons" USING btree (("official_ids"->>'bioguide'));