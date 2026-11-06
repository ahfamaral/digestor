---
name: digestor-run
description: Launch the Digestor stack (Colima, docker compose, Next.js dev server), seed demo sessions at the context-check pause or fully analysed (`ready`), and drive the journalist flow (Briefing, Prepare, Export), and drive the web UI with Playwright to take screenshots and catch console errors. Use this whenever you need to see a Digestor screen, confirm a UI or API change works in the real app rather than only in tests, check a layout at phone width, reproduce a UI bug, or prepare screenshots for the capstone README/showcase — even if the user just says "check it works", "how does the briefing look" or "run the app".
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
| both | the whole flow: Processing → Context check → Briefing → Prepare → Export (real analysis, translated subtitles, Ask) |

Without keys, anything AI fails with the friendly "`<VAR>` is not set on the server." text (for example a translated subtitle track, shown inline in Prepare). The English track of an English video is the original, so it needs no key. Cutting and rendering need no key, so Prepare → Export works on the seed.

Without keys, **seed** a session (synthetic video, transcript and card):

```bash
# ready: ≈ 10 min mayor interview, one complete analysis (3 topics, 14 moments, briefing, checks + thumbnails on the top highlights)
docker compose exec -w /app/apps/worker worker node --import tsx scripts/seed-demo.ts --stage ready
# parked at the context check (4.6 min, two open questions)
docker compose exec -w /app/apps/worker worker node --import tsx scripts/seed-demo.ts --stage awaiting_context
```

Each prints `http://localhost:3000/s/<id>`. Seeded sessions have no LangGraph checkpoint, so Continue / Skip are accepted by the API but ignored by the worker — the stage stays where the web moved it. Good for looking at screens, keyboard triage, Prepare and Export (renders run for real in the worker container), not for testing the pipeline. Each `--stage ready` run creates a new session, so seed a fresh one for a clean end-to-end pass. For pipeline behaviour, use worker tests or real keys.

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
  && npm i playwright@1.56.1
```

The scripts launch **Google Chrome** (`channel: "chrome"`), because Playwright's bundled Chromium cannot play H.264 (the proxy and clips). Install Chrome on the host once.

Then (from the repo root):

```bash
node .claude/skills/digestor-run/scripts/drive.mjs --out <scratch>/shots \
  --visit / --visit /s/<contextId> --visit /s/<readyId> \
  --visit /s/<readyId>/prepare --visit /s/<readyId>/export --visit /reports \
  --keys "/s/<readyId>=/,Escape" \
  --upload ./data/sample.mp4 \
  --mobile
```

- `--visit <path>` full-page screenshot; `--keys <path>=k1,k2` presses keys in order with a screenshot after each (`/` opens the Ask drawer on the Briefing page, `Escape` closes it; there are no letter shortcuts); `--upload <file>` goes through the upload page (`/new`) and follows the redirect to `/s/<id>`; `--mobile` adds a 390 px-wide copy of each shot.
- If `APP_PASSWORD` is set, pass `--password` (or export `APP_PASSWORD`); the script logs in when redirected to `/login`.
- Console errors, uncaught page errors and 5xx responses go to `<out>/errors.txt`. An empty file is part of "it works".

Then **look at the screenshots** (Read the PNGs) — a screenshot nobody looked at proves nothing. Check: the stepper shows the right step, badges/labels use the spec's wording ("Heated", "Key point", "Light moment"), nothing overflows at 390 px, errors render inline.

For flows the script doesn't cover (Confirm, trim, 9:16, credit, adding a subtitle language, Export and waiting for "Rendered"), write a short throwaway Playwright script in your scratch directory using the same `createRequire(~/.cache/digestor-run/package.json)` trick as `drive.mjs`; prefer role/label selectors (`getByRole`, `getByLabel`). Handy ones: on the Briefing page the rows' buttons are "Approve: <title>" / "Skip: <title>" (`aria-pressed`), the level checkboxes "Exchanges" / "Passages" / "Punchlines", the status filter `#show-status`, and the confirm button "Prepare clips →"; the Prepare fields are labelled "Start" / "End", "Crop position", the credit input has the placeholder "e.g. the channel or broadcaster", the language Dropdown (a button, not a `select`) is "Subtitle language" and its button "Add"; the way on to Export is a *link* "Export ready clips →" (on Export itself it is a button); a finished render shows "Rendered".

The full journalist pass to run before calling a UI change done: Briefing (`/` Ask drawer; approve 2 moments and skip 1 with the buttons, click one again to undo; untick a level; pick a highlight-type chip that hides an approved moment to see "N approved · M hidden by filters" and "Show hidden") → "Prepare clips →" → Prepare (trim, 9:16, credit, add a language) → Export (render), at 1280 and 390 px.

To check a rendered clip's credit line or crop, extract a frame **inside the worker container** (`docker compose exec worker ffmpeg -ss 60 -i /data/<id>/clips/<clipId>.mp4 -frames:v 1 /data/<id>/frame.png`), copy it out, look at it, and delete it. Never run ffmpeg on the host.

## 4. Report and clean up

- Report what you looked at, with the screenshot paths, and anything in `errors.txt`.
- Leave the stack running unless asked; stop your background dev server if you started it for a one-off check.
- Seeded and uploaded sessions live in the dev DB and `./data/<id>/`; the daily retention job removes their source video after `VIDEO_RETENTION_DAYS`. Don't delete other sessions — they may be the owner's.
