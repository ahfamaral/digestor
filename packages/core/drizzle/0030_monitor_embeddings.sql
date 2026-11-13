CREATE TABLE "parl_speech_embeddings" (
	"speech_key" text PRIMARY KEY NOT NULL,
	"chunks" integer NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL
);
