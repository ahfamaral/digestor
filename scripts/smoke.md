# Manual smoke checklist

Needs real `ANTHROPIC_API_KEY` and `ASSEMBLYAI_API_KEY` in `.env`. Use a 20-40 min interview in a non-English language. Run it twice: once from a YouTube link, once as an uploaded file.

Setup: `colima start --cpu 4 --memory 8`, `docker compose up -d --build`, `pnpm install`, `pnpm db:migrate`, `pnpm --filter @digestor/web dev`, open http://localhost:3000.

## 1. Full run

- [ ] Intake: paste the YouTube link (run A) or upload the file (run B).
- [ ] Processing: the stepper advances through download, ingest, transcribe, context.
- [ ] Context check: answer one question (or skip) and continue.
- [ ] Inbox: approve 2 clips, mark 1 neutral, reject 1 (keys `A`, `N`, `R`), edit one clip's times (`E`).
- [ ] Render the approved clips.
- [ ] Export: download the MP4 and the SRT.

Expected:
- [ ] Subtitles are in the spoken language.
- [ ] No clip starts or ends mid-sentence.
- [ ] Rendered duration matches the snapped start/end times within 0.2 s (check with the player or `docker compose run --rm worker ffprobe`).
- [ ] Invalid times (end before start, past the video end, `1:2:3x`) show an inline error and save nothing.

## 2. Restart test

- [ ] Start a new session. While it is transcribing, stop the worker (`docker compose stop worker`, or Ctrl-C if running in the foreground).
- [ ] Start it again (`docker compose up -d worker`).

Expected:
- [ ] The job is retried and the session reaches the context check or the review inbox.
- [ ] No duplicate clips in the inbox.

## 3. Ask (real Claude tool calls)

The Ask fakes (`FakeToolLLM`) are shaped from the `@langchain/anthropic` 1.6 / `@langchain/core` 1.3 types, not from a recorded response. On a `ready` session:

- [ ] "What did speaker A say about <topic>?" → the answer cites `[hh:mm:ss]`, and the stored message's `toolCalls` show `search_transcript`.
- [ ] Ask in another language than the video → the answer is in the question's language.
- [ ] "Make a clip of the first answer" → one clip and one personal moment (`origin: ask`); bounds on sentence edges.
- [ ] "Approve all key points" (more than 3) → a pending `bulk_selection` action, no selection applied.
- [ ] Something not in the video → "That isn't in this video's data."
- [ ] Stop Chroma (`docker compose stop chroma`) and ask → "Search isn't available for this video."
- [ ] Record one raw tool-call response to `apps/worker/test/fixtures/anthropic/ask-tool-call.recorded.json` and feed it through `fromAIMessage` in a test.
