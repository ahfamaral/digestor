ALTER TABLE "clips" ADD COLUMN "credit_set_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "clips" SET "credit_set_at" = "updated_at" WHERE "credit_set_at" IS NULL AND coalesce(trim("credit"), '') <> '';
