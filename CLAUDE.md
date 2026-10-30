# Digestor

Long public-interest videos (interviews, parliament, UN, trials) → subtitled clips. Turing College capstone. All TypeScript (strict, ESM), pnpm monorepo:

- `packages/core`: zod domain schemas, profiles and highlight types (`profiles.ts`), time/snap logic, subtitle text (`subtitleText.ts`), Drizzle tables + repo functions, LocalStorage, queue names and `JOB_OPTIONS`.
- `apps/worker`: pg-boss consumer, LangGraph pipeline (`src/pipeline/graph.ts`, one human pause: the context check), analysis agents (topics, moments, briefing, checks), Ask, Chroma search index, AssemblyAI, Claude via LangChain, ffmpeg, yt-dlp, retention clean-up and stale-session sweep, evaluation (`src/eval`, `scripts/eval.ts`).
- `apps/web`: Next.js 16 (App Router, Cache Components, Turbopack): screens + API routes + SSE.

## The journalist flow

Stepper: Upload › Processing › Context › Preview › Briefing › Prepare › Export. Routes: `/` (upload), `/s/[id]` (Processing, Context check, then Preview once `ready`), `/s/[id]/briefing` (Full briefing: triage), `/s/[id]/prepare`, `/s/[id]/export`, `/reports`. The Ask drawer opens with `/` on Preview and Full briefing.

- Stages (`schemas.ts`): `uploaded`, `downloading`, `preparing`, `transcribing`, `understanding`, `awaiting_context`, `indexing`, `finding_topics`, `finding_moments`, `writing_briefing`, `ready`, `failed`.
- Profiles (`profiles.ts`): `parliament`, `supreme_court`, `electoral_debate`, `trial` (sensitive), `interview`, `un`, `other`. Each profile lists its highlight types; a type is `ai` or `counted` (`longest_speech`). The chip colour comes from `HIGHLIGHT_TYPES[*].tone` via `components/HighlightChip.tsx`.
- An analysis is a versioned set of topics, moments (granularity `exchange` / `passage` / `punchline`), highlights and a briefing; selections, clips and subtitle tracks are a personal layer (`owner_id`, `OWNER_ID = "owner"`) that survives re-analysis.
- Queues (`packages/core/src/queue.ts`, all with `JOB_OPTIONS`): `session.start`, `session.resume`, `session.reanalyze`, `moment.check`, `track.prepare`, `track.burn`, `clip.render`, `briefing.translate`, `ask.run`; scheduled in the worker: `session.sweep` (every 15 min) and `maintenance.cleanup` (daily).
- Retention: `VIDEO_RETENTION_DAYS` (default 14) deletes `original.*`, `audio.mp3`, `proxy.mp4` and the LangGraph checkpoint; analyses, personal layers and rendered clips stay. The sweep fails sessions and analysis versions with no progress for 120 minutes.
- Chroma is live: one collection per session (`session_<uuid without dashes>`) with a transcript index for Ask, using local `Xenova/multilingual-e5-small` embeddings cached in `data/models` (`HF_HOME`).

Spec: `docs/superpowers/specs/2026-10-28-video-digestor-design.md` (v1) and `docs/superpowers/specs/2026-10-30-digestor-ui-concept-design.md` (the journalist flow, Plan 2 onwards). Plans: `docs/superpowers/plans/`. Deploy runbook: `docs/deploy.md`. Manual real-API checklist: `scripts/smoke.md`.

## Environment

- Docker runs on **Colima** (`colima start --cpu 4 --memory 8`), not Docker Desktop. `docker compose up -d` starts postgres, chroma (transcript index for Ask) and the worker; the web app runs on the host: `pnpm --filter @digestor/web dev`.
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
| Evaluation table | `docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval.ts <sessionId> <golden.json>` (golden path relative to `apps/worker`) |
| Migrations | `pnpm db:migrate` (wait for postgres healthy) |
| Prod build (one VPS) | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` |

After adding a dependency: `pnpm install` on the host first (updates the lockfile); the worker entrypoint syncs on restart.

## Conventions that bite

- `@digestor/core` is client-safe; DB, repo, storage and migrate come from `@digestor/core/server`. Never import `/server` from a client component.
- Relative imports inside `packages/core` use `.ts` extensions (Turbopack can't map `.js` → `.ts`); the worker uses `.js`. Keep each package's convention.
- The DB stores storage-relative keys (`<sessionId>/original.mp4`), never absolute paths; each process resolves them against its own `DATA_DIR`.
- Uploaded files are saved as `original.<ext>`; user filenames never reach ffmpeg.
- Concurrency is guarded in the database, not by pg-boss:
  - stage changes via `transitionStage` (compare-and-set);
  - `confirmClips` and `claimAnalysisVersion` run under `pg_advisory_xact_lock(hashtext(sessionId))`;
  - renders and burns use claim/finish compare-and-set (`claimClipRender` / `finishClipRender`, `claimTrackBurn` / `finishTrackBurn`); a burn or render whose cues, bounds or credit changed meanwhile is marked `stale`;
  - Ask actions use `resolveAskAction` (compare-and-set), and Ask undo only reverts what the call itself set.
- `singletonKey` is a no-op on our standard queues: never rely on it to dedupe; claim in the database first, then send.
- Subtitle SRT/VTT downloads are rendered from the track's cues on every request (never stored files), and drafts stay downloadable; burn-in needs per-language approval.
- Trim: the server always snaps to sentence boundaries. Alt/Option in the UI only previews free positions.
- Approved moments are never hidden by filters: the briefing footer reads "N approved · M hidden by filters" with a "Show hidden" button.
- Every boundary (AI or human) goes through `snapRange`; cuts never start or end mid-sentence.
- User-facing errors are friendly sentences; raw errors go to logs only.
- Exact domain values (profiles, highlight types, statuses, fact sources, granularities, render settings) live in `packages/core/src/profiles.ts` and `schemas.ts` (and the specs) — use them verbatim.

## Skills in this repo (`.claude/skills/`)

- `digestor-run`: launch the stack, seed demo sessions, drive the UI with Playwright, screenshot.
- `pgboss-langgraph-gotchas`: read before touching jobs, queues, the pipeline graph, resume or retries.
- `vendor-contract-check`: before writing or changing a fake for AssemblyAI, Claude or yt-dlp.
- `llm-structured-output`: before adding or changing any LLM call that returns structured data.
- `digestor-ui`: before building or changing any screen or component (tokens, colours, copy, keyboard, a11y). The concept is agreed (UI concept spec); mockups in `docs/design/` are inspiration only.
- `nextjs16-gotchas`: before changing pages, route handlers, middleware, streaming routes, next.config or the web Dockerfile.

## Workflow

- The owner says "banana" to approve starting work; give a time estimate first. Short status tables when asked "how is it going".
- Commit only when asked; never commit `.env`, `data/`, `node_modules`, `.pnpm-store`.
