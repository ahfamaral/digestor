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
WORKDIR /app

# dev: dependencies only; source is bind-mounted at /app by compose
FROM base AS dev
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@digestor/worker", "dev"]

# prod: source baked in
FROM base AS prod
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["node", "--import", "tsx", "apps/worker/src/main.ts"]
