# Digestor

Long public-interest videos (interviews, parliament, UN, trials) → subtitled clips. Turing College capstone. All TypeScript (strict, ESM), pnpm monorepo:

- `packages/core`: zod domain schemas, time/snap logic, Drizzle tables + repo functions, LocalStorage, queue names and `JOB_OPTIONS`.
- `apps/worker`: pg-boss consumer, LangGraph pipeline (`src/pipeline/graph.ts`) with two human pauses (context check, clip review), AssemblyAI, Claude via LangChain, ffmpeg, yt-dlp, retention clean-up.
- `apps/web`: Next.js 16 (App Router, Cache Components, Turbopack): screens + API routes + SSE.

Spec: `docs/superpowers/specs/2026-10-28-video-digestor-design.md`. Plans: `docs/superpowers/plans/`. Deploy runbook: `docs/deploy.md`. Manual real-API checklist: `scripts/smoke.md`.

## Environment

- Docker runs on **Colima** (`colima start --cpu 4 --memory 8`), not Docker Desktop. `docker compose up -d` starts postgres, chroma (reserved for Plan 2) and the worker; the web app runs on the host: `pnpm --filter @digestor/web dev`.
- **Never install or call ffmpeg/yt-dlp on the host** (host ffmpeg has no libass). Anything that runs them — worker code and its tests — runs in the worker container.
- API keys live in `.env` (`ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY`); they may be empty. The worker starts without them and fails a job with "`<VAR>` is not set on the server." when first needed. `APP_PASSWORD` empty = password gate off.
- The worker container bind-mounts the repo and runs `tsx watch`; after editing worker code over the Colima mount, `docker compose restart worker` if the change isn't picked up.

## Commands

| What | Command |
|---|---|
| Host-safe tests (core, web) | `pnpm test` |
| Worker tests (in container) | `pnpm test:worker` · focused: `docker compose run --rm worker pnpm --filter @digestor/worker test <pattern>` |
| Focused core/web test | `pnpm --filter @digestor/core test <pattern>` / `pnpm --filter @digestor/web test <pattern>` |
| Typecheck | `pnpm typecheck` |
| Migrations | `pnpm db:migrate` (wait for postgres healthy) |
| Prod build (one VPS) | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` |

After adding a dependency: `pnpm install` on the host first (updates the lockfile); the worker entrypoint syncs on restart.

## Conventions that bite

- `@digestor/core` is client-safe; DB, repo, storage and migrate come from `@digestor/core/server`. Never import `/server` from a client component.
- Relative imports inside `packages/core` use `.ts` extensions (Turbopack can't map `.js` → `.ts`); the worker uses `.js`. Keep each package's convention.
- The DB stores storage-relative keys (`<sessionId>/original.mp4`), never absolute paths; each process resolves them against its own `DATA_DIR`.
- Uploaded files are saved as `original.<ext>`; user filenames never reach ffmpeg.
- Concurrency is guarded in the database, not by pg-boss: stage changes via `transitionStage` (compare-and-set), renders via `claimClipRender` / `finishClipRender`. `replaceAiClips` only runs before review.
- Every boundary (AI or human) goes through `snapRange`; cuts never start or end mid-sentence.
- User-facing errors are friendly sentences; raw errors go to logs only.
- Exact domain values (labels, statuses, event types, fact sources, clip lengths, render settings) are in the spec's global constraints — use them verbatim.

## Skills in this repo (`.claude/skills/`)

- `digestor-run`: launch the stack, seed demo sessions, drive the UI with Playwright, screenshot.
- `pgboss-langgraph-gotchas`: read before touching jobs, queues, the pipeline graph, resume or retries.
- `vendor-contract-check`: before writing or changing a fake for AssemblyAI, Claude or yt-dlp.
- `llm-structured-output`: before adding or changing any LLM call that returns structured data.
- `nextjs16-gotchas`: before changing pages, route handlers, middleware, streaming routes, next.config or the web Dockerfile.

## Workflow

- The owner says "banana" to approve starting work; give a time estimate first. Short status tables when asked "how is it going".
- Commit only when asked; never commit `.env`, `data/`, `node_modules`, `.pnpm-store`.
