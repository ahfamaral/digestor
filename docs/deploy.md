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
| `APP_PASSWORD` | **Required.** A strong password, for example from `openssl rand -base64 24`. The app is public, and compose refuses to start `web` without it. |
| `MAX_UPLOAD_GB` | Upload limit (default 5). |
| `VIDEO_RETENTION_DAYS` | Source videos (and the pipeline checkpoints) older than this are removed daily at 03:00 UTC (default 14). Sessions, briefings, thumbnails and rendered clips stay. Sessions still processing are never touched. |
| `PUBLIC_HOSTNAME` | The DNS name from step 2, for example `digestor.example.com` (no `https://`). |

Optional: `HTTP_PORT` and `HTTPS_PORT` (default 80 and 443) change the host ports Caddy listens on. Keep the defaults on a VPS: Let's Encrypt needs ports 80/443 to issue the certificate. Other values are only for local rehearsals (see below).

`.env` holds secrets: never commit it (it is git-ignored) and keep it readable only by you (`chmod 600 .env`).

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

YouTube often asks for a bot check when downloads come from a data-centre IP. Digestor does not use cookies or proxies, so on a VPS a YouTube link may fail with "YouTube blocked this download from the server. Download the video yourself and upload the file instead." That is expected: download the video on your own machine and upload the file. Uploads always work.

## Local production rehearsal

You can run the production stack on your laptop next to the dev stack by using a separate compose project and other ports (so dev data is untouched):

```
PUBLIC_HOSTNAME=localhost HTTP_PORT=8080 HTTPS_PORT=8443 APP_PASSWORD=<something> \
  docker compose -p digestor-prod -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Open `https://localhost:8443` (Caddy uses its own local certificate; accept the browser warning). Tear it down with the same variables and `down -v` (removes only the `digestor-prod` volumes).
