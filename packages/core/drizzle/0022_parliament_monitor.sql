-- Hand-written head: accent-insensitive Portuguese full-text search for the parliament monitor.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION pt_unaccent ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;--> statement-breakpoint
CREATE TABLE "parl_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"house" text NOT NULL,
	"external_id" integer NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"party" text,
	"uf" text,
	"photo_url" text,
	"in_office" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parl_members_house_external_id_unique" UNIQUE("house","external_id")
);
--> statement-breakpoint
CREATE TABLE "parl_roll_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"house" text NOT NULL,
	"date" date NOT NULL,
	"registered_at" timestamp,
	"description" text NOT NULL,
	"yes" integer NOT NULL,
	"no" integer NOT NULL,
	"other" integer NOT NULL,
	"bill_id" integer,
	"bill_label" text,
	"bill_summary" text DEFAULT '' NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('pt_unaccent', bill_summary), 'A') || setweight(to_tsvector('pt_unaccent', description), 'B')) STORED
);
--> statement-breakpoint
CREATE TABLE "parl_speeches" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"starts_at" timestamp NOT NULL,
	"phase" text,
	"kind" text,
	"summary" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"keywords" text DEFAULT '' NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('pt_unaccent', summary || ' ' || keywords), 'A') || setweight(to_tsvector('pt_unaccent', text), 'B')) STORED
);
--> statement-breakpoint
CREATE TABLE "parl_votes" (
	"roll_call_id" text NOT NULL,
	"member_id" integer NOT NULL,
	"vote" text NOT NULL,
	CONSTRAINT "parl_votes_roll_call_id_member_id_pk" PRIMARY KEY("roll_call_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "parl_speeches" ADD CONSTRAINT "parl_speeches_member_id_parl_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."parl_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_votes" ADD CONSTRAINT "parl_votes_roll_call_id_parl_roll_calls_id_fk" FOREIGN KEY ("roll_call_id") REFERENCES "public"."parl_roll_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parl_votes" ADD CONSTRAINT "parl_votes_member_id_parl_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."parl_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parl_members_name_norm_trgm" ON "parl_members" USING gin ("name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "parl_roll_calls_tsv" ON "parl_roll_calls" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "parl_roll_calls_date" ON "parl_roll_calls" USING btree ("date");--> statement-breakpoint
CREATE INDEX "parl_speeches_member_starts" ON "parl_speeches" USING btree ("member_id","starts_at");--> statement-breakpoint
CREATE INDEX "parl_speeches_tsv" ON "parl_speeches" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "parl_votes_member" ON "parl_votes" USING btree ("member_id");