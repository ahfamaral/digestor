CREATE TABLE "parl_bill_authors" (
	"bill_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"first_author" boolean NOT NULL,
	CONSTRAINT "parl_bill_authors_bill_id_member_id_pk" PRIMARY KEY("bill_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "parl_bills" (
	"id" integer PRIMARY KEY NOT NULL,
	"house" text NOT NULL,
	"type" text NOT NULL,
	"number" integer NOT NULL,
	"year" integer NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"presented_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parl_member_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"at" timestamp NOT NULL,
	"party" text,
	"uf" text,
	"status" text,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parl_orientations" (
	"roll_call_id" text NOT NULL,
	"bloc" text NOT NULL,
	"orientation" text DEFAULT '' NOT NULL,
	CONSTRAINT "parl_orientations_roll_call_id_bloc_pk" PRIMARY KEY("roll_call_id","bloc")
);
--> statement-breakpoint
CREATE TABLE "parl_presence" (
	"session_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	CONSTRAINT "parl_presence_session_id_member_id_pk" PRIMARY KEY("session_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "parl_sessions" (
	"id" integer PRIMARY KEY NOT NULL,
	"house" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parl_members" ADD COLUMN "profession" text;--> statement-breakpoint
ALTER TABLE "parl_members" ADD COLUMN "external_mandates" jsonb;--> statement-breakpoint
ALTER TABLE "parl_members" ADD COLUMN "fronts" jsonb;--> statement-breakpoint
ALTER TABLE "parl_members" ADD COLUMN "positions" jsonb;--> statement-breakpoint
ALTER TABLE "parl_members" ADD COLUMN "profile_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parl_speeches" ADD COLUMN "speech_key" text;--> statement-breakpoint
ALTER TABLE "parl_speeches" ADD COLUMN "party" text;--> statement-breakpoint
ALTER TABLE "parl_speeches" ADD COLUMN "uf" text;--> statement-breakpoint
ALTER TABLE "parl_votes" ADD COLUMN "party" text;--> statement-breakpoint
ALTER TABLE "parl_votes" ADD COLUMN "uf" text;--> statement-breakpoint
ALTER TABLE "parl_bill_authors" ADD CONSTRAINT "parl_bill_authors_bill_id_parl_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."parl_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_bill_authors" ADD CONSTRAINT "parl_bill_authors_member_id_parl_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."parl_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_member_history" ADD CONSTRAINT "parl_member_history_member_id_parl_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."parl_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_orientations" ADD CONSTRAINT "parl_orientations_roll_call_id_parl_roll_calls_id_fk" FOREIGN KEY ("roll_call_id") REFERENCES "public"."parl_roll_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_presence" ADD CONSTRAINT "parl_presence_session_id_parl_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."parl_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_presence" ADD CONSTRAINT "parl_presence_member_id_parl_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."parl_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parl_bill_authors_member" ON "parl_bill_authors" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "parl_bills_presented_at" ON "parl_bills" USING btree ("presented_at");--> statement-breakpoint
CREATE INDEX "parl_member_history_member_at" ON "parl_member_history" USING btree ("member_id","at");--> statement-breakpoint
CREATE INDEX "parl_presence_member" ON "parl_presence" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parl_speeches_key" ON "parl_speeches" USING btree ("speech_key");