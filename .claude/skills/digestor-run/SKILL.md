---
name: digestor-run
description: Launch the Digestor stack (Colima, docker compose, Next.js dev server), seed demo sessions at the context-check or review pause, and drive the web UI with Playwright to take screenshots and catch console errors. Use this whenever you need to see a Digestor screen, confirm a UI or API change works in the real app rather than only in tests, check a layout at phone width, reproduce a UI bug, or prepare screenshots for the capstone README/showcase — even if the user just says "check it works", "how does the inbox look" or "run the app".
---

# Run and see Digestor

Tests prove units; this skill proves the screens. Use it after any change a user would see (components, pages, API routes the UI calls, SSE, keyboard handling), and before claiming a UI change is done.

## 1. Bring the stack up

```bash
colima status || colima start --cpu 4 --memory 8
docker compose up -d                       # postgres, chroma, worker
docker compose ps                          # postgres must be "healthy"
pnpm db:migrate                            # idempotent
lsof -iTCP:3000 -sTCP:LISTEN || (pnpm --filter @digestor/web dev > <scratch>/web-dev.log 2>&1 &)
```

Run the dev server in the background (your shell tool's background mode), then wait until `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` returns 200 or 307. First compile of a page takes a few seconds.

ffmpeg and yt-dlp exist only in the worker container — never install or call them on the host.

## 2. Get a session to look at

What you can reach depends on the API keys in `.env`:

| Keys | Reachable for real |
|---|---|
| none | Upload → Processing → "Something went wrong" (`ASSEMBLYAI_API_KEY is not set on the server.`) |
| both | the whole flow: Processing → Context check → Inbox → Render → Export |

Without keys, **seed** a session (synthetic video, transcript and card):

```bash
# finished: ≈ 10 min mayor interview, one complete analysis (3 topics, 12 moments, briefing, checks + thumbnails on the top highlights)
docker compose exec -w /app/apps/worker worker node --import tsx scripts/seed-demo.ts --stage ready
# parked at the context check (4.6 min, two open questions)
docker compose exec -w /app/apps/worker worker node --import tsx scripts/seed-demo.ts --stage awaiting_context
```

Each prints `http://localhost:3000/s/<id>`. Seeded sessions have no LangGraph checkpoint, so Continue / Skip are accepted by the API but ignored by the worker — the stage stays where the web moved it. Good for looking at screens and keyboard triage, not for testing the pipeline. For pipeline behaviour, use worker tests or real keys.

A test video to upload (made in the container, written to `./data` on the host):

```bash
docker compose exec worker ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=25 \
  -f lavfi -i sine=frequency=440 -t 90 -c:v libx264 -pix_fmt yuv420p -c:a aac /data/sample.mp4
# host path: ./data/sample.mp4
```

## 3. Drive the UI

Playwright is installed outside the repo so it never touches the lockfile. One-time:

```bash
mkdir -p ~/.cache/digestor-run && cd ~/.cache/digestor-run && ( [ -f package.json ] || npm init -y >/dev/null ) \
  && npm i playwright@1.56.1 && npx playwright install chromium
```

Then (from the repo root):

```bash
node .claude/skills/digestor-run/scripts/drive.mjs --out <scratch>/shots \
  --visit / --visit /s/<contextId> --visit /s/<reviewId> --visit /s/<reviewId>/export \
  --keys "/s/<reviewId>=a,ArrowDown,n,ArrowDown,r" \
  --upload ./data/sample.mp4 \
  --mobile
```

- `--visit <path>` full-page screenshot; `--keys <path>=k1,k2` presses keys in order with a screenshot after each (inbox keys: `a` approve, `n` neutral, `r` reject, `e` edit times, `ArrowDown`/`ArrowUp`, `Escape`); `--upload <file>` goes through the home page and follows the redirect to `/s/<id>`; `--mobile` adds a 390 px-wide copy of each shot.
- If `APP_PASSWORD` is set, pass `--password` (or export `APP_PASSWORD`); the script logs in when redirected to `/login`.
- Console errors, uncaught page errors and 5xx responses go to `<out>/errors.txt`. An empty file is part of "it works".

Then **look at the screenshots** (Read the PNGs) — a screenshot nobody looked at proves nothing. Check: the stepper shows the right step, badges/labels use the spec's wording ("Heated", "Key point", "Light moment"), nothing overflows at 390 px, errors render inline.

For flows the script doesn't cover (time-edit dialog, render button, SSE progress), write a short throwaway Playwright script in your scratch directory using the same `createRequire(~/.cache/digestor-run/package.json)` trick as `drive.mjs`; prefer role/label selectors (`getByRole`, `getByLabel`) the way the components expose them.

## 4. Report and clean up

- Report what you looked at, with the screenshot paths, and anything in `errors.txt`.
- Leave the stack running unless asked; stop your background dev server if you started it for a one-off check.
- Seeded and uploaded sessions live in the dev DB and `./data/<id>/`; the daily retention job removes their source video after `VIDEO_RETENTION_DAYS`. Don't delete other sessions — they may be the owner's.
