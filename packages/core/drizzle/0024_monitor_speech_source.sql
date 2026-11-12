ALTER TABLE "parl_speeches" ADD COLUMN "url_text" text;--> statement-breakpoint
ALTER TABLE "parl_speeches" ADD COLUMN "text_file" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Data clean-up (the worker cleans new rows the same way, apps/worker/src/monitor/camara.ts `cleanText`): the Câmara's
-- texts carry Windows-1252 bytes as C1 control characters (0x97 is an em dash, 0x93/0x94 curly quotes…); map them to the
-- characters they stand for, the five undefined ones to a space. The speech key is recomputed by the next nightly refresh
-- inside its window (nothing links to keys yet).
UPDATE "parl_speeches" SET
  "summary" = translate("summary", E'\u0080\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008A\u008B\u008C\u008E\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009A\u009B\u009C\u009E\u009F\u0081\u008D\u008F\u0090\u009D', E'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ     '),
  "text" = translate("text", E'\u0080\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008A\u008B\u008C\u008E\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009A\u009B\u009C\u009E\u009F\u0081\u008D\u008F\u0090\u009D', E'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ     '),
  "keywords" = translate("keywords", E'\u0080\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008A\u008B\u008C\u008E\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009A\u009B\u009C\u009E\u009F\u0081\u008D\u008F\u0090\u009D', E'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ     ')
WHERE "summary" ~ E'[\u0080-\u009F]' OR "text" ~ E'[\u0080-\u009F]' OR "keywords" ~ E'[\u0080-\u009F]';
--> statement-breakpoint
-- Speeches published as an attached .docx (its bytes inside the text): keep only the heading before the file.
UPDATE "parl_speeches" SET
  "text_file" = true,
  "text" = btrim(regexp_replace(substring("text" from 1 for position('[Content_Types].xml' in "text") - 1), 'PK.{0,80}$', ''))
WHERE "text" LIKE '%[Content_Types].xml%';
