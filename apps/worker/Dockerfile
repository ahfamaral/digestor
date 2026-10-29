# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
ARG YTDLP_VERSION=2026.10.26
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg fonts-noto-core fonts-noto-cjk fontconfig python3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) asset=yt-dlp_linux_aarch64 ;; \
      amd64) asset=yt-dlp_linux ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}" \
 && chmod +x /usr/local/bin/yt-dlp
RUN corepack enable
ENV PNPM_STORE_DIR=/pnpm-store
ENV npm_config_store_dir=/pnpm-store
WORKDIR /app

# dev: dependencies only; source is bind-mounted at /app by compose
FROM base AS dev
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY apps/worker/sync-deps-entrypoint.sh /usr/local/bin/sync-deps-entrypoint.sh
ENTRYPOINT ["sync-deps-entrypoint.sh"]
CMD ["pnpm", "--filter", "@digestor/worker", "dev"]

# prod: worker + core only, production deps, source baked in, runs as the unprivileged `node` user
FROM base AS prod
ENV NODE_ENV=production
# manifests first, so source edits don't invalidate the dependency layer
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# the store is dropped in the same layer (node_modules keeps its own links/copies), keeping the image small
RUN CI=true pnpm install --frozen-lockfile --prod --filter "@digestor/worker..." \
 && rm -rf /pnpm-store
COPY packages/core packages/core
COPY apps/worker/package.json apps/worker/tsconfig.json apps/worker/
COPY apps/worker/src apps/worker/src
# /data owned by node so a fresh named volume mounted there is writable by the worker (and web, same uid)
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/apps/worker
CMD ["node", "--import", "tsx", "src/main.ts"]
