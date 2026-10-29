# Digestor

Turns long videos into subtitled clips: upload a file or paste a YouTube link, review AI-proposed clips, export the ones you approve.

## Local setup

Prerequisites (one-time, macOS):

1. `brew install colima docker docker-compose`
2. Add `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` to `~/.docker/config.json`.
3. `colima start --cpu 4 --memory 8`, then check `docker compose version`.
4. pnpm via corepack (`corepack enable`). If corepack fails its signature check, run `npm i -g corepack@latest`.

Then:

```
cp .env.example .env
pnpm install
docker compose up -d --build   # postgres, chroma, worker
```

Never install ffmpeg or yt-dlp on the host; they run inside the worker container.

Notes:
- `docker/initdb` (creates `digestor_test`) only runs when the postgres volume is first created.
- The worker entrypoint runs `pnpm install --frozen-lockfile` on every start, so the `node_modules` volumes stay in sync after dependency changes.

## Tests

- `pnpm test` — host-safe packages only
- `pnpm test:worker` — worker tests inside the container (ffmpeg, yt-dlp, fonts)
- `pnpm test:all` — both
