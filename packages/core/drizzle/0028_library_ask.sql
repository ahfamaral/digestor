CREATE TABLE "library_ask_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"sources" jsonb,
	"tool_calls" jsonb,
	"status" text DEFAULT 'done' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "library_ask_messages_owner_idx" ON "library_ask_messages" USING btree ("owner_id","created_at");