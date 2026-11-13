# Deploying Digestor to a single VPS

Production runs everything on one server with Docker Compose: `postgres`, `chroma`, a one-shot `migrate`, the `worker`, the Next.js `web` app and `caddy` (HTTPS with automatic certificates). The production override `docker-compose.prod.yml` builds production images, keeps Postgres and Chroma off the public network and stores files in a shared Docker volume mounted at `/data` in `web` and `worker`.

## 1. Create the server

- A VPS with **4 vCPU, 8 GB RAM, 80+ GB disk**, running **Ubuntu LTS** (24.04 or newer). Rendering and transcoding are CPU-bound; uploads and renders need disk (keep at least 3x your largest upload free).
- Add your SSH key when you create it and log in as a sudo user.

## 2. Point a domain at it

Create a DNS **A record** for your hostname (for example `digestor.example.com`) pointing to the server's public IPv4 address (and an AAAA record if it has IPv6). Wait until `dig +short digestor.example.com` returns the server IP: Caddy needs this to obtain the certificate.

## 3. Firewall

Allow SSH and web traffic only:

```
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

If your provider has a cloud firewall, open the same ports there. Postgres (5432) and Chroma (8000) are not published by the production compose file, so they do not need rules.

## 4. Install Docker Engine and the Compose plugin

Follow the official guide for Ubuntu (https://docs.docker.com/engine/install/ubuntu/), which installs `docker-ce` and `docker-compose-plugin`. Then:

```
sudo usermod -aG docker $USER   # log out and back in
docker compose version          # needs 2.24 or newer
```

## 5. Clone the repo

```
git clone <repo-url> digestor
cd digestor
```

## 6. Write `.env`

```
cp .env.example .env
nano .env
```

Fill in every variable:

| Key | Production value |
| --- | --- |
| `DATABASE_URL`, `TEST_DATABASE_URL`, `DATA_DIR` | Leave as in `.env.example`; compose overrides them inside the containers (host `postgres`, `/data`). |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (context agent, clip finder). |
| `ASSEMBLYAI_API_KEY` | Your AssemblyAI API key (transcription). |
| `APP_PASSWORD` | **Required.** A strong password, for example from `openssl rand -base64 24`. The app is public, and compose refuses to start `web` without it. Wrong passwords are throttled per client address (5 in 10 minutes), read from `X-Forwarded-For`, which Caddy sets to the real peer. Putting a CDN or another proxy in front of Caddy would make every client look like that proxy's address. |
| `MAX_UPLOAD_GB` | Upload limit (default 5). |
| `VIDEO_RETENTION_DAYS` | Source videos (and the pipeline run rows) older than this are removed daily at 03:00 UTC (default 14). Sessions, briefings, thumbnails and rendered clips stay. Sessions still processing are never touched. |
| `POSTGRES_PASSWORD` | **Required.** The database password, letters and digits only (it goes inside `DATABASE_URL`), for example `openssl rand -hex 24`. Compose refuses to start without it. It only takes effect when the `pgdata` volume is first created: on a server that already has data, also run `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres psql -U digestor -d digestor -c "ALTER USER digestor PASSWORD '<the new password>'"` before restarting. |
| `PUBLIC_HOSTNAME` | The DNS name from step 2, for example `digestor.example.com` (no `https://`). |

Optional: `HTTP_PORT` and `HTTPS_PORT` (default 80 and 443) change the host ports Caddy listens on. Keep the defaults on a VPS: Let's Encrypt needs ports 80/443 to issue the certificate. Other values are only for local rehearsals (see below).

`.env` holds secrets: never commit it (it is git-ignored) and keep it readable only by you (`chmod 600 .env`).

The images run as the unprivileged `node` user (uid 1000). A fresh `appdata` volume is writable by it. If the volume already exists from an older root-run image, fix its ownership once: `docker run --rm -v digestor_appdata:/data busybox chown -R 1000:1000 /data` (use your volume's real name). The cookies file in `secrets/` (mode 600) must be owned by uid 1000, the first user on most VPSes; otherwise run `sudo chown 1000 secrets/youtube-cookies.txt`, since the worker reads it as `node`.

## 7. Start

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The first build takes several minutes. `migrate` applies the database migrations and exits; `web` and `worker` start after it succeeds. Caddy then obtains a certificate for `PUBLIC_HOSTNAME`.

Open `https://<PUBLIC_HOSTNAME>`: you should see the login page with a valid certificate. Then run the manual checklist in [`scripts/smoke.md`](../scripts/smoke.md) against the deployed site.

To save typing, set `export COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` in your shell profile; then plain `docker compose ...` uses both files. The commands below spell them out.

## Setting or changing API keys

Edit `.env`, then recreate the containers so they pick up the new values:

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Without keys the app still runs, and sessions fail with a clear message such as "ASSEMBLYAI_API_KEY is not set on the server."

## Logs

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f worker web
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 100 caddy
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs migrate
```

The worker logs each daily clean-up as `cleanup: deleted N session(s) older than D day(s)`.

## Updating

```
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations run automatically through the `migrate` service before `web` and `worker` restart. A job interrupted by the restart is retried automatically; one that was mid-run can take up to its 4-hour expiry before it is picked up again, so prefer updating when nothing is processing. Old images can be removed with `docker image prune`.

### Once, when updating to the step runner (migration 0019)

The pipeline no longer uses LangGraph; its position is the `pipeline_runs` table and migration 0019 drops the `checkpoint*` tables.

- Update when nothing is processing. This must return no rows (sessions at `awaiting_context` are safe: a resume continues them):

  ```
  select id, stage from sessions where stage not in ('ready','failed','awaiting_context');
  ```

  Why: `up -d --build` runs `migrate` (it drops the checkpoint tables) while the old worker still runs for a few seconds.
- Dev/demo: sessions seeded by an older `seed-demo.ts` have no run row and would run the paid pipeline on Continue or Skip. Delete them, or give them a done row:

  ```
  insert into pipeline_runs(session_id,next_step) select id,'done' from sessions where title like '%(seeded)' on conflict do nothing;
  ```
- If an older worker ran after 0019, it recreated empty `checkpoint*` tables; drop them:

  ```
  DROP TABLE IF EXISTS "checkpoint_writes", "checkpoint_blobs", "checkpoints", "checkpoint_migrations";
  ```

### Once, when updating to the resume round (migration 0020)

Migration 0020 adds a CHECK on `pipeline_runs.next_step`. Before updating, this must return no rows (otherwise the one-shot `migrate` fails and `web` and `worker` don't start):

```
select next_step, count(*) from pipeline_runs where next_step not in ('download','ingest','transcribe','match_record','understand_context','ask_context','match_record_late','name_speakers','index','analyze','done') group by 1;
```

### Once, when updating to the Câmara monitor (migration 0022)

`up -d --build` runs migrations 0021 (LLM cost per analysis version) and 0022 (the monitor tables; it creates the `unaccent` and `pg_trgm` extensions, which ship with the `postgres:17` image). Then load the 2026 data once (about 6 minutes; safe to run again):

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-backfill.ts
```

It prints the counts (dev on 2026-11-11: 568 deputies, 8,055 speeches, 126 roll calls, 51,450 votes; 74 MB). Open `/monitor` and search a deputy and a topic. The worker refreshes it daily at 09:00 UTC; the next morning check the log line:

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs worker | grep monitor.refresh
```

Query translation uses `OPENROUTER_API_KEY` from `.env` in the `web` container (without it, searches run on the words as typed).

### Once, when updating to the monitor workspace (migration 0023)

`up -d --build` runs migration 0023 (history, profiles, guidance, sessions and presence, bills and authors; party on the day for speeches and at the vote for votes). Then rerun the backfill once so the new tables fill (about 16 minutes now: it also reads every deputy's history and profile; safe to run again):

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-backfill.ts
```

Dev on 2026-11-11 printed: 568 deputies, history and profiles 568 ok / 0 failed, 1,700 guidance rows, 82 plenary sessions, 38,497 presence rows, 52,205 bill authorships, in 927 s. Check `/monitor` (pick a deputy in the "Find a deputy" box, open a roll call from a topic search) and one deputy's page: the party timeline, "Present at N of M…" and the bills list show. The nightly refresh now also reads every deputy's history (568 calls) and, on Mondays, every profile.

### Once, when updating to the monitor fix round (migration 0024)

`up -d --build` runs migration 0024: speeches get `url_text` (the Câmara's page for the text) and `text_file` (published as an attached file), the Windows-1252 leftovers in speech texts become the characters they stand for (em dashes, curly quotes), and the speeches that carried a .docx keep only their heading. The backfill above (run once for 0023) also fills `url_text` for older speeches; when 0023 and 0024 deploy together, one backfill run covers both. Dev on 2026-11-11: 8,055 speeches reloaded, 4,353 with a text link (the API has none for the rest), 5 attached files, no C1 characters left, in 718 s. The nightly refresh recomputes the speech keys of the cleaned speeches inside its 60-day window once (nothing links to keys yet).

### Once, when updating to video evidence (migration 0025)

`up -d --build` runs migration 0025: `parl_session_videos` (each held plenary's official YouTube video and the state of matching it) and `parl_speech_videos` (each speech's start and end second in that video, keyed by the speech key). With `MONITOR_VIDEO_ENABLED=true` the worker matches one session every 5 minutes on its own (`monitor.video`; captions only, no video is downloaded). **Leave it unset on this server**: on 2026-11-12 YouTube blocked the server's IP for caption fetches even with the cookies (rotated twice, after about 25 requests each). Unset or anything but `true`, the worker removes the job's schedule at startup and logs `monitor.video: off`. The sessions are matched from a home connection instead, once a week (any day after Thursday's plenary; a run that finds nothing to do is harmless), from the Mac with Colima running:

```
pnpm monitor:videos:prod            # every session that needs it, 20 s apart; --max N to stop earlier
```

`scripts/monitor-videos-prod.sh` reads `PROD_SSH` (`deploy@<server>`) and `PROD_SSH_KEY` from the local `.env`, opens an SSH tunnel to the prod postgres container (its address and password are read over SSH at run time; the database is never exposed), runs `scripts/monitor-videos.ts` in a throwaway local worker container against it, with the local code and no YouTube cookies, and closes the tunnel. It queues new held plenaries, plenaries whose speech texts arrived since their last match, and plenaries whose speeches got new keys (the nightly refresh stored a revised text, so their stored moments point nowhere). Safe to stop and rerun. The local code must match what prod runs (deploy first if the monitor schema changed).

On the server itself the same script would run with `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-videos.ts --pause 180`, but YouTube blocks it there.

The same update makes the nightly refresh remove speeches the Câmara files under two deputies with overlapping names (Mauricio Marcon's under Marcon too); the first refresh after the update cleans the stored ones (109 in dev on 2026-11-12).

### Once, when updating to the monitor's search by meaning (migration 0030)

`up -d --build` runs migration 0030 (`parl_speech_embeddings`: which speeches are in the meaning index) and starts the worker's internal HTTP endpoint on port 8790. Nothing publishes that port in production: the web container reaches it on the compose network as `http://worker:8790` (`WORKER_URL`, set in `docker-compose.prod.yml`; no `.env` change needed). Then build the index once (local e5 model, no paid calls; safe to stop and rerun, it continues where it stopped):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-embed.ts
```

Dev on 2026-11-13 (the Mac's Colima VM, 4 CPUs): 7,899 speeches in 23,460 chunks in 2,284 s (about 38 minutes; the worker test suite ran alongside for part of it); the worker container used about 2.5 GB of memory while the script ran inside it (`docker stats`), so on a 4 GB server run it when nothing else is processing. Until it has run, the topic search shows word results with the note "Search by meaning isn't available right now" (the same happens whenever the worker is restarting). Afterwards the worker adds each day's new and revised speeches at 10:00 UTC (`monitor.embed`, an hour after the refresh); check the next morning:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs worker | grep monitor.embed
```

### Once, after updating to speaker names (Plan 3)

Sessions analysed before speaker names existed keep their names only in the context card, so Who's who shows "No name yet" and their clips fail the speaker check. Import the card's names as proposals (confirm them in Who's who afterwards). It skips every session that already has names, so running it again is safe, and it never calls an LLM:

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec worker pnpm --filter @digestor/worker exec tsx scripts/import-names.ts
```

If the same person shows twice in Who's who (a custom name next to the official record person), fold the duplicates together. It merges only same-name pairs where one row is official, and a second run changes nothing:

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec worker pnpm --filter @digestor/worker exec tsx scripts/merge-persons.ts
```

## Backups

The database lives in the `pgdata` volume and files in the `appdata` volume (volume names are prefixed with the compose project name, usually the folder name, for example `digestor_pgdata`).

Back up Postgres with a logical dump (safe while running):

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U digestor -d digestor -Fc > digestor-$(date +%F).dump
```

Restore (stop `web` and `worker` first so nothing holds connections, start them again afterwards):

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop web worker
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U digestor -d digestor --clean --if-exists < digestor-YYYY-MM-DD.dump
docker compose -f docker-compose.yml -f docker-compose.prod.yml start web worker
```

Copy dumps off the server (for example with `scp`). Uploaded and rendered files are short-lived by design (`VIDEO_RETENTION_DAYS` for the source video); to keep them too, archive the files volume:

```
docker run --rm -v digestor_appdata:/data -v "$PWD":/backup busybox tar czf /backup/appdata-$(date +%F).tgz -C /data .
```

## YouTube links on a server

YouTube often asks for a bot check when downloads come from a data-centre IP. Without cookies a YouTube link may then fail with "YouTube blocked this download from the server. Download the video yourself and upload the file instead." Uploads always work.

To get past the bot check, give the worker the cookies of a logged-in YouTube session:

1. Use a separate Google account, not your personal one: YouTube can flag or suspend accounts used for downloads.
2. In a private/incognito browser window, log in to YouTube, then open `https://www.youtube.com/robots.txt` in the same tab.
3. Export the `youtube.com` cookies in Netscape `cookies.txt` format (for example with the "Get cookies.txt LOCALLY" extension), then close the private window without logging out. Closing it this way keeps YouTube from rotating the cookies you just exported.
4. Save the file as `secrets/youtube-cookies.txt` in the repo folder on the server (`secrets/` is git-ignored and kept out of images; the worker mounts it read-only at `/secrets`), and `chmod 600` it.
5. Set `YTDLP_COOKIES_FILE=/secrets/youtube-cookies.txt` in `.env` and run `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d worker`.

The mounted file is never changed. The worker keeps a live copy in the data volume (`/data/.youtube/cookies.txt`, owner-only) that yt-dlp updates after every request with the cookies YouTube refreshed, as a browser would; on 2026-11-12 a session used with a fresh copy every time was rotated after about 20 requests. Requests that use the cookies run one at a time. Replacing `secrets/youtube-cookies.txt` with a new export is enough: the worker notices the change on the next request and starts the live copy again from it (no restart needed). When YouTube blocks a download or a caption fetch despite cookies, the worker logs "blocked even with YTDLP_COOKIES_FILE: the cookies may have expired"; export fresh ones (and never open that account in a browser afterwards). A missing file is logged and the request goes ahead without cookies.

## US House and Senate records (key required)

Speaker names for US floor sittings come from the Congressional Record on GovInfo (`https://api.govinfo.gov`, one package `CREC-YYYY-MM-DD` per day). It needs a free api.data.gov key (sign up at `https://api.data.gov/signup/`, instant, about 1000 requests per hour) in `API_DATA_GOV_KEY`; apply it with `docker compose up -d worker`. Without it a linked US record fails with "API_DATA_GOV_KEY is not set on the server." and is not retried. The public `DEMO_KEY` works for a trial but allows only about 10 requests an hour. A sitting costs one request for the day's list plus one or two per House or Senate item, so a long day can take a few hundred requests. The daily edition appears the next morning (US time); a fresh sitting waits up to 3 days and is retried.

## Bundestag records (optional key)

Speaker names for German sittings come from the Bundestag's open-data Plenarprotokoll XML. Digestor finds the file by reading the list on `https://www.bundestag.de/services/opendata`; if Bundestag changes that page and the list can't be read, the record shows an error that names the list URL. `BUNDESTAG_DIP_API_KEY` is an optional fallback: with a key (personal keys come from `parlamentsdokumentation@bundestag.de`; see the DIP API help page), a failed list falls back to the DIP API. Leave it blank to run without the fallback. The Bundestag publishes the finished protocol some days after a sitting, so a fresh sitting waits (up to 21 days) and is retried.

## Local production rehearsal

You can run the production stack on your laptop next to the dev stack by using a separate compose project and other ports (so dev data is untouched):

```
PUBLIC_HOSTNAME=localhost HTTP_PORT=8080 HTTPS_PORT=8443 APP_PASSWORD=<something> POSTGRES_PASSWORD=<letters-and-digits> \
  docker compose -p digestor-prod -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Open `https://localhost:8443` (Caddy uses its own local certificate; accept the browser warning). Tear it down with the same variables and `down -v` (removes only the `digestor-prod` volumes).

## Official parliament video links

Checked 2026-11-04 with yt-dlp 2026.10.26 inside the worker container (`docker compose exec worker yt-dlp --simulate --print title --print "%(upload_date)s %(duration)s %(extractor)s" <url>`). A host counts as accepted only if it returns a title and a duration. None did, so the link tab still accepts YouTube only and no code changed.

| URL tried | Outcome |
|---|---|
| `https://www.bundestag.de/mediathek/video?videoid=7666987` (current Mediathek page URL) | `Unsupported URL` (generic extractor; the Bundestag extractor does not match this path) |
| `https://www.bundestag.de/mediathek?videoid=7666987` (the only form the Bundestag extractor matches) | extractor runs, page 404s; generic title `Bundestag video #7666987`, duration and date `NA` |
| `https://live.house.gov`, `https://live.house.gov/?date=2026-11-03` | `Unsupported URL` (player is JS; no video URL in the HTML) |
| `https://clerk.house.gov/Videos` | 404 |
| `https://www.senate.gov/legislative/floor_activity_pages.htm`, `https://www.senate.gov/isvp/?type=live&comm=floor&filename=floor111126` | 403 (Akamai blocks the server, `senate.gov:isvp` extractor never gets the page) |

Mediathek sitting: the video page `<title>` reads "104. Sitzung vom 04.11.2026, TOP 1: ..." and the Mediathek list fragment (`/ajax/filterlist/de/mediathek/...`) carries the date and "N. Sitzung". It is plain HTML, but parsing it needs a fetch, which `parseRecordRef` (pure) does not do, so a Mediathek link in the record field still gets "Paste the date or sitting number instead." Recheck when yt-dlp's Bundestag extractor is fixed for `/mediathek/video?videoid=`.
