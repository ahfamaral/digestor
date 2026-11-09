CREATE TABLE "pipeline_runs" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"next_step" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP TABLE IF EXISTS "checkpoint_writes", "checkpoint_blobs", "checkpoints", "checkpoint_migrations";
