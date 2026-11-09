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

Each download uses its own temporary copy, so the file is never changed. When YouTube blocks a download despite cookies, the worker logs "blocked even with YTDLP_COOKIES_FILE: the cookies may have expired"; export fresh ones. A missing file is logged and the download goes ahead without cookies.

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
