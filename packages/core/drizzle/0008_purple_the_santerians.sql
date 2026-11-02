CREATE TABLE "find_more_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"analysis_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"moment_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "find_more_owner_analysis_person" UNIQUE("owner_id","analysis_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "moments" ADD COLUMN "find_more_request_id" uuid;--> statement-breakpoint
ALTER TABLE "find_more_requests" ADD CONSTRAINT "find_more_requests_analysis_id_analysis_versions_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analysis_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "find_more_requests" ADD CONSTRAINT "find_more_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_find_more_request_id_find_more_requests_id_fk" FOREIGN KEY ("find_more_request_id") REFERENCES "public"."find_more_requests"("id") ON DELETE cascade ON UPDATE no action;