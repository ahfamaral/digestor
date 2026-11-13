CREATE TABLE "parl_bloc_parties" (
	"bloc_id" integer NOT NULL,
	"party" text NOT NULL,
	CONSTRAINT "parl_bloc_parties_bloc_id_party_pk" PRIMARY KEY("bloc_id","party")
);
--> statement-breakpoint
CREATE TABLE "parl_blocs" (
	"id" integer PRIMARY KEY NOT NULL,
	"house" text NOT NULL,
	"legislature" integer NOT NULL,
	"name" text NOT NULL,
	"federation" boolean NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parl_record_embeddings" (
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"hash" text NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parl_record_embeddings_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
ALTER TABLE "parl_bloc_parties" ADD CONSTRAINT "parl_bloc_parties_bloc_id_parl_blocs_id_fk" FOREIGN KEY ("bloc_id") REFERENCES "public"."parl_blocs"("id") ON DELETE cascade ON UPDATE no action;