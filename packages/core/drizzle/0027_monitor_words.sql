CREATE TABLE "parl_word_counts" (
	"member_id" integer NOT NULL,
	"party" text DEFAULT '' NOT NULL,
	"month" date NOT NULL,
	"stem" text NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "parl_word_counts_member_id_party_month_stem_pk" PRIMARY KEY("member_id","party","month","stem")
);
--> statement-breakpoint
ALTER TABLE "parl_word_counts" ADD CONSTRAINT "parl_word_counts_member_id_parl_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."parl_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parl_word_counts_party" ON "parl_word_counts" USING btree ("party");--> statement-breakpoint
CREATE INDEX "parl_word_counts_stem" ON "parl_word_counts" USING btree ("stem");