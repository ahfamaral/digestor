# Digestor

Long public-interest videos (interviews, parliament, UN, trials) → subtitled clips. Turing College capstone. All TypeScript (strict, ESM), pnpm monorepo:

- `packages/core`: zod domain schemas, profiles and highlight types (`profiles.ts`), time/snap logic, subtitle text (`subtitleText.ts`), Drizzle tables + repo functions, LocalStorage, queue names and `JOB_OPTIONS`.
- `apps/worker`: pg-boss consumer, LangGraph pipeline (`src/pipeline/graph.ts`, one human pause: the context check), analysis agents (topics, moments, briefing, checks), Ask, Chroma search index, AssemblyAI, Claude via LangChain, ffmpeg, yt-dlp, retention clean-up and stale-session sweep, evaluation (`src/eval`, `scripts/eval.ts`).
- `apps/web`: Next.js 16 (App Router, Cache Components, Turbopack): screens + API routes + SSE.

## The journalist flow

Stepper: Upload › Processing › Context › Preview › Briefing › Prepare › Export. Routes: `/` (upload), `/s/[id]` (Processing, Context check, then Preview once `ready`), `/s/[id]/briefing` (Full briefing: triage), `/s/[id]/prepare`, `/s/[id]/export`, `/reports`. The Ask drawer opens with `/` on Preview and Full briefing.

- Stages (`schemas.ts`): `uploaded`, `downloading`, `preparing`, `transcribing`, `understanding`, `awaiting_context`, `naming_speakers`, `indexing`, `finding_topics`, `finding_moments`, `writing_briefing`, `ready`, `failed`.
- Profiles (`profiles.ts`): `parliament`, `supreme_court`, `electoral_debate`, `trial` (sensitive), `interview`, `un`, `other`. Each profile lists its highlight types; a type is `ai` or `counted` (`longest_speech`). The chip colour comes from `HIGHLIGHT_TYPES[*].tone` via `components/HighlightChip.tsx`.
- An analysis is a versioned set of topics, moments (granularity `exchange` / `passage` / `punchline`), highlights and a briefing; selections, clips and subtitle tracks are a personal layer (`owner_id`, `OWNER_ID = "owner"`). Selections belong to one analysis version's moments: after a re-analysis they no longer show (the Full briefing counts them per version), while clips and their subtitle tracks keep working.
- Queues (`packages/core/src/queue.ts`, all with `JOB_OPTIONS`): `session.start`, `session.resume`, `session.reanalyze`, `moment.check`, `track.prepare`, `track.burn`, `clip.render`, `briefing.translate`, `ask.run`, `moment.find_more`, `session.names` (match a linked Senado record; at upload the graph's `match_record` node does it before the context check); scheduled in the worker: `session.sweep` (every 15 min) and `maintenance.cleanup` (daily).
- Retention: `VIDEO_RETENTION_DAYS` (default 14) deletes `original.*`, `audio.mp3`, `proxy.mp4`, the LangGraph checkpoint and the session's Chroma index (so Ask search stops working after 14 days); analyses, personal layers and rendered clips stay. The sweep fails sessions and analysis versions with no progress for 120 minutes, and job rows stuck for 30 minutes (below).
- Chroma is live: one collection per session (`session_<uuid without dashes>`) with a transcript index for Ask, using local `Xenova/multilingual-e5-small` embeddings cached in `data/models` (`HF_HOME`).

Spec: `docs/superpowers/specs/2026-10-28-video-digestor-design.md` (v1) and `docs/superpowers/specs/2026-10-30-digestor-ui-concept-design.md` (the journalist flow, Plan 2 onwards). Plans: `docs/superpowers/plans/`. Deploy runbook: `docs/deploy.md`. Manual real-API checklist: `scripts/smoke.md`.

## Environment

- Docker runs on **Colima** (`colima start --cpu 4 --memory 8`), not Docker Desktop. `docker compose up -d` starts postgres, chroma (transcript index for Ask) and the worker; the web app runs on the host: `pnpm --filter @digestor/web dev`.
- **Never install or call ffmpeg/yt-dlp on the host** (host ffmpeg has no libass). Anything that runs them — worker code and its tests — runs in the worker container.
- API keys live in `.env` (`ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY`); they may be empty. `LLM_PROVIDER=anthropic|openrouter` (default anthropic) picks the LLM vendor (`apps/worker/src/llm/provider.ts`); the key it needs is the one a missing-key failure names. Every structured call goes through `StructuredLLM` and Ask through `ToolLLM`, so a provider is one adapter pair; analysis versions record provider-qualified model ids (`StructuredLLM.modelIds`). Changing `.env` needs `docker compose up -d worker` (restart doesn't re-read it). The worker starts without them and fails a job with "`<VAR>` is not set on the server." when first needed. `APP_PASSWORD` empty = password gate off.
- YouTube from a server IP hits a bot check: `YTDLP_COOKIES_FILE` (a cookies.txt in git-ignored `./secrets/`, mounted read-only at `/secrets`) gets past it; see `docs/deploy.md`.
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
| Import old sessions' card names as proposals (once, idempotent) | `docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/import-names.ts` |
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
  - `moment.check` is claimed with `claimMomentCheck` (checks null and no claim younger than 10 min); a failed send or a job that gives up calls `releaseMomentCheck`. Ask answers are claimed with `claimAskMessage` (`pending` → `running`); a retry that finds `running` fails the message instead of repeating tool calls.
- Subtitle tracks record the clip range they were built for (`built_start_ms` / `built_end_ms`). Any bounds change (trim, extend, undo, Ask `trim_clip`) marks other-range tracks `outdated` and clears approval in the same transaction; outdated tracks have no SRT/VTT, fail the checklist and are rebuilt through `POST /api/clips/[id]/tracks` (R27).
- Moment checks describe the moment's bounds: they count for a clip only while its bounds equal the moment's (`checksForClip`); any bounds change resets `warningsAck` (R28).
- The sweep also fails job rows whose job died: translations `pending`, tracks `preparing`, renders and burns `queued`/`rendering`, "Find more" requests `pending`/`running`, record fetches `pending`/`running`, untouched for 30 min with no live job matched on pg-boss job data (R32). New job-owned rows belong there too.
- Once a session's video is removed (`videoDeletedAt`), kept clips are frozen: clip edits, undo and track edits/approve/burn answer 409 with `VIDEO_REMOVED`; acknowledgements and downloads still work (R30).
- Ask makes at most 3 direct changes per question, counting each moment of `set_selection`, each `propose_clip` and each `trim_clip`; beyond that selections become a confirm action and clip calls are refused. Tool output built from transcript-derived text (search hits, transcript, moment titles and reasons) goes through `evidence()` (R31).
- Subtitle SRT/VTT downloads are rendered from the track's cues on every request (never stored files), and drafts stay downloadable; burn-in needs per-language approval.
- Trim: the server always snaps to sentence boundaries. Alt/Option in the UI only previews free positions.
- Approved moments are never hidden by filters: the briefing footer reads "N approved · M hidden by filters" with a "Show hidden" button.
- Every boundary (AI or human) goes through `snapRange`; cuts never start or end mid-sentence.
- Claude 5.5 (`claude-sonnet-5-5`, `claude-haiku-5-5`, also via OpenRouter) rejects `temperature`/`top_p`/`top_k` and forced `tool_choice`, and thinks by default: no sampling parameters, structured output via `method: "jsonSchema"`, and Ask replays each tool turn's raw content (thinking blocks) unchanged (`ToolStep.raw`). Wire-level tests use the injected `fetch` in `apps/worker/src/llm/fakeFetch.ts`.
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
