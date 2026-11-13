ALTER TABLE "ask_actions" ADD COLUMN "resolution" jsonb;--> statement-breakpoint
ALTER TABLE "ask_messages" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ask_actions_tool_approval_step" ON "ask_actions" USING btree ("message_id",("payload"->>'step')) WHERE "ask_actions"."kind" = 'tool_approval';--> statement-breakpoint
-- Ask's LangGraph checkpoints (PostgresSaver, schema "ask_graph"): the worker's setup() creates the tables here.
CREATE SCHEMA IF NOT EXISTS "ask_graph";
