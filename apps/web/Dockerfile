# syntax=docker/dockerfile:1
# Production image for the Next.js app. Build context: the repo root
# (docker build -f apps/web/Dockerfile .), so the workspace package @digestor/core is available.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# deps: manifests first, so source edits don't invalidate the install layer
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN CI=true pnpm install --frozen-lockfile --filter "@digestor/web..."

# build: `next build` with output: "standalone" (traced from the repo root)
FROM deps AS build
COPY . .
# public/ is empty and untracked by git; make sure it exists for the runtime COPY
RUN mkdir -p apps/web/public && pnpm --filter @digestor/web build

# runtime: only the standalone server, static assets and public files
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
# /data owned by node so a fresh named volume mounted there is writable (the worker runs as the same uid)
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
