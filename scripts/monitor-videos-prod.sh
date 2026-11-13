#!/usr/bin/env bash
# Weekly run from the owner's Mac: matches the Câmara plenaries' YouTube videos into PRODUCTION's database from a home
# connection (YouTube blocks the server's IP, see docs/deploy.md). An SSH tunnel reaches prod's postgres container
# (never exposed to the internet), a throwaway local worker container runs scripts/monitor-videos.ts against it without
# YouTube cookies, and both are gone afterwards. Only captions are fetched; nothing is written to the Mac's disk.
#
#   pnpm monitor:videos:prod                 # every session that needs it, 20 s apart
#   pnpm monitor:videos:prod --max 3         # at most 3 sessions
#
# Needs Colima running and, in the git-ignored .env: PROD_SSH (user@host) and PROD_SSH_KEY (private key path).
set -euo pipefail
cd "$(dirname "$0")/.."

envval() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s|^~|$HOME|"; }
PROD_SSH="${PROD_SSH:-$(envval PROD_SSH)}"
PROD_SSH_KEY="${PROD_SSH_KEY:-$(envval PROD_SSH_KEY)}"
LOCAL_PORT="${MONITOR_TUNNEL_PORT:-15432}"
[ -n "$PROD_SSH" ] && [ -n "$PROD_SSH_KEY" ] || { echo "Set PROD_SSH and PROD_SSH_KEY in .env first." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker isn't running: start Colima first (colima start --cpu 4 --memory 4)." >&2; exit 1; }
if nc -z 127.0.0.1 "$LOCAL_PORT" 2>/dev/null; then echo "Port $LOCAL_PORT is busy; set MONITOR_TUNNEL_PORT to a free one." >&2; exit 1; fi

ssh_prod() { ssh -i "$PROD_SSH_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15 -o BatchMode=yes "$PROD_SSH" "$@"; }

echo "Reading prod's database address…"
PG_IP="$(ssh_prod 'docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" digestor-postgres-1')"
PG_PASSWORD="$(ssh_prod 'grep -E "^POSTGRES_PASSWORD=" ~/digestor/.env | tail -1 | cut -d= -f2-')"
[ -n "$PG_IP" ] && [ -n "$PG_PASSWORD" ] || { echo "Couldn't read prod's database address or password." >&2; exit 1; }

ssh -i "$PROD_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -N -L "127.0.0.1:$LOCAL_PORT:$PG_IP:5432" "$PROD_SSH" &
TUNNEL_PID=$!
cleanup() { kill "$TUNNEL_PID" 2>/dev/null || true; wait "$TUNNEL_PID" 2>/dev/null || true; echo "Tunnel closed."; }
trap cleanup EXIT INT TERM
for _ in $(seq 1 30); do nc -z 127.0.0.1 "$LOCAL_PORT" 2>/dev/null && break; sleep 0.5; done
nc -z 127.0.0.1 "$LOCAL_PORT" 2>/dev/null || { echo "The SSH tunnel didn't open." >&2; exit 1; }
echo "Tunnel open. Matching sessions (captions only, no cookies)…"

# The password travels as an environment variable only: never on a command line or on disk.
export DATABASE_URL="postgres://digestor:${PG_PASSWORD}@host.docker.internal:${LOCAL_PORT}/digestor"
docker compose run --rm --no-deps -T -e DATABASE_URL -e YTDLP_COOKIES_FILE= worker \
  pnpm --filter @digestor/worker exec tsx scripts/monitor-videos.ts "$@"
