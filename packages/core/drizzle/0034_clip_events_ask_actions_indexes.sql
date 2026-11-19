CREATE INDEX "ask_actions_message_idx" ON "ask_actions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "clip_events_clip_idx" ON "clip_events" USING btree ("clip_id");