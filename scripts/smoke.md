# Manual smoke checklist

Needs real `ANTHROPIC_API_KEY` and `ASSEMBLYAI_API_KEY` in `.env` (§4 also needs `OPENROUTER_API_KEY`). Use a 20-40 min interview in a non-English language. Run it twice: once from a YouTube link, once as an uploaded file.

Setup: `colima start --cpu 4 --memory 8`, `docker compose up -d --build`, `pnpm install`, `pnpm db:migrate`, `pnpm --filter @digestor/web dev`, open http://localhost:3000.

## 1. Full run

- [ ] Intake: paste the YouTube link (run A) or upload the file (run B).
  - On a server IP, once without and once with `YTDLP_COOKIES_FILE` (docs/deploy.md): without, the bot-check sentence; with, the download works. Not yet verified with real cookies past a real bot check.
- [ ] Processing: the stepper advances through download, ingest, transcribe, context.
- [ ] Context check: answer one question (or skip) and continue; profile is detected or chosen.
- [ ] Preview: timeline, top highlights and briefing appear; Play a highlight; "Looks right → Full briefing".
- [ ] Full briefing: approve 2 moments, mark 1 neutral, reject 1 (keys `A`, `N`, `R`); filter by granularity, focus speaker and highlight type; "Confirm selection → Prepare clips".
- [ ] Prepare clips: trim one clip (handles snap to sentence pauses), switch one to 9:16 and move the crop, add a credit line, add the video's own subtitle language and approve it.
- [ ] Export: "Export ready clips"; download the MP4, SRT and VTT.

Expected:
- [ ] Subtitles are in the spoken language.
- [ ] No clip starts or ends mid-sentence.
- [ ] Rendered duration matches the snapped start/end times within 0.2 s (check with `docker compose run --rm worker ffprobe`).
- [ ] 9:16 output is 720x1280 and the credit line is legible bottom-right, not clipped.
- [ ] Invalid times (end before start, past the video end, `1:2:3x`) show an inline error and save nothing.

## 1b. New-flow extras

- [ ] **Audio-only file** (an mp3 or m4a): the session reaches Preview; Prepare shows "This file has no video: the export shows a waveform in this shape." and the render is a waveform on a dark background (1280x720, or 720x1280 for 9:16). On Upload, picking the file shows "This file has no video. Clips will show a waveform instead of a picture." and Upload stays disabled until "I understand clips from this file will have no video picture." is ticked.
- [ ] **Translated track**: add a second subtitle language in Prepare; the lines are translated, the editor shows original and subtitle side by side, empty lines block approval, approving then burning in produces a "Burned-in MP4" on Export.
- [ ] Translate the briefing from Preview ("Read in"); quotes keep the original text first.
- [ ] Re-analyse from "Something's off" with a different profile: the old results stay until the new version finishes.
- [ ] Trial profile: the Prepare checklist asks "I checked that no protected person (witness, victim or minor) can be identified."
- [ ] Retention: with `VIDEO_RETENTION_DAYS=0`-style testing not allowed (it falls back to 14), age a session's `created_at` in the database, run the cleanup, and check Play shows "The video was removed after 14 days. Re-upload it to make new clips." while rendered clips still download.

## Record real vendor fixtures at smoke time

No API keys were available while Plan 2 was built, so every AI fake is shaped from SDK types and docs, not from recorded responses (see `vendor-contract-check`). On the first keyed run, record and commit:

- [ ] A real AssemblyAI transcript for a short non-English clip, a real Claude structured-output response for each of topics, moments, briefing, checks and translation, and one real Chroma query/response, each under `apps/worker/test/fixtures/` with a `*.recorded.json` name, then run them through the real parsers in tests.
- [ ] A real embedding vector shape from `Xenova/multilingual-e5-small` (dimension, normalisation).

## 2. Restart test

- [ ] Start a new session. While it is transcribing, stop the worker (`docker compose stop worker`, or Ctrl-C if running in the foreground).
- [ ] Start it again (`docker compose up -d worker`).

Expected:
- [ ] The job is retried and the session reaches the context check or the Preview.
- [ ] No duplicate topics or moments in the Full briefing.

## 3. Ask (real Claude tool calls)

The Ask fakes (`FakeToolLLM`) are shaped from the `@langchain/anthropic` 1.6 / `@langchain/core` 1.3 types, not from a recorded response. On a `ready` session:

- [ ] "What did speaker A say about <topic>?" → the answer cites `[hh:mm:ss]`, and the stored message's `toolCalls` show `search_transcript`.
- [ ] Ask in another language than the video → the answer is in the question's language.
- [ ] "Make a clip of the first answer" → one clip and one personal moment (`origin: ask`); bounds on sentence edges.
- [ ] "Approve all key points" (more than 3) → a pending `bulk_selection` action, no selection applied.
- [ ] Something not in the video → "That isn't in this video's data."
- [ ] Stop Chroma (`docker compose stop chroma`) and ask → "Search isn't available for this video."
- [ ] A question that needs two tool rounds works: the second request carries the first turn's `thinking` blocks unchanged (Claude 5.5 rejects edited or dropped ones).
- [ ] Record one raw tool-call response to `apps/worker/test/fixtures/anthropic/ask-tool-call.recorded.json` and feed it through `fromAIMessage` in a test.

## 4. OpenRouter (`LLM_PROVIDER=openrouter`)

The OpenRouter fakes in `apps/worker/src/llm/openrouter.test.ts` are shaped from OpenRouter's docs (OpenAI-compatible Chat Completions) and the `@langchain/openai` 1.8 code, not from a recorded response. Set `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY` in `.env`, then `docker compose up -d worker`:

- [ ] The worker log says `LLM provider: openrouter (reasoning anthropic/claude-sonnet-5.5, fast anthropic/claude-haiku-5.5)`.
- [ ] With `OPENROUTER_API_KEY` empty, a new session fails with "OPENROUTER_API_KEY is not set on the server."
- [ ] A full run reaches Preview; `analysis_versions.models` shows `openrouter:` ids.
- [ ] Ask answers with `[hh:mm:ss]` citations and a `search_transcript` tool call.
- [ ] Translate the briefing into one language.
- [ ] A structured reply comes back as JSON content (`response_format` json_schema) and the worker log shows no LangChain retry backoff for it.
- [x] Ask with two tool rounds works through OpenRouter (2026-10-31): thinking comes back as `reasoning_details`, which `@langchain/openai` 1.8 drops; OpenRouter accepted a third round with and without it, so it is not replayed (replaying it would keep the model's earlier reasoning — optional improvement).
- [ ] One non-Claude model (for example `OPENROUTER_MODEL_REASONING=google/gemini-3.8-flash`): a re-analysis completes or fails with the friendly message, never a raw error. Note which models refuse forced function calling.
- [ ] Unverified cases to check: a 200 response whose body carries `error` instead of `choices` (OpenRouter documents this, https://openrouter.ai/docs/api-reference/errors); 402 out of credits (the session should fail after the retries with the generic message; the raw error goes to the log).
- [x] Record one raw structured-output response and one raw tool-call response to `apps/worker/test/fixtures/openrouter/*.recorded.json` and feed them through the adapter in a test (2026-10-31: `topics`, `ask-tool-call`, `ask-answer`).
