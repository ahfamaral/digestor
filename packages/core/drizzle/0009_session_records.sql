CREATE TABLE "session_records" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"chamber" text NOT NULL,
	"ref" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"raw_key" text,
	"fetched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_records" ADD CONSTRAINT "session_records_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;