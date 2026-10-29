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
