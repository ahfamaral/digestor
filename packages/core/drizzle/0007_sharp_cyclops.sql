CREATE TABLE "attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"speaker_id" text NOT NULL,
	"start_ms" integer,
	"end_ms" integer,
	"person_id" uuid,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"full_name" text,
	"kind" text NOT NULL,
	"party" text,
	"state" text,
	"role" text,
	"photo_url" text,
	"official_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name_norm" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_versions" ADD COLUMN "names_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attributions_session_speaker" ON "attributions" USING btree ("session_id","speaker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persons_official_senado" ON "persons" USING btree (("official_ids"->>'senado'));--> statement-breakpoint
CREATE UNIQUE INDEX "persons_official_camara" ON "persons" USING btree (("official_ids"->>'camara'));--> statement-breakpoint
CREATE INDEX "persons_name_norm" ON "persons" USING btree ("name_norm");