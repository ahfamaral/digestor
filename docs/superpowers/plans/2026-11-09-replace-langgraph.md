# Replace LangGraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The upload pipeline runs on a small step runner of our own, with its position stored in Postgres, and the worker no longer depends on `@langchain/langgraph` or its checkpointer.

**Architecture:** A fixed list of steps (the same node functions as today) and a `pipeline_runs` row per session holding the next step, the context round and the answers. Each step returns the next step; the runner advances the row with compare-and-set and stops at the context check. `session.start` and `session.resume` call the runner; the web app does not change.

**Tech Stack:** TypeScript (ESM, strict), Drizzle, pg-boss 12, vitest.

**Spec:** no spec doc. Source: owner's approval of the switch (2026-11-06, `parliament-monitor-vision` memory: "LangGraph → own stage runner") and the design agreed in chat on 2026-11-09. Branch `replace-langgraph` from `main`. **Merge only on the owner's word; the owner expects it after the capstone demo** (the README's technique table names LangGraph).

## Global Constraints

- Step order and branching are exactly today's `buildPipeline` edges (`apps/worker/src/pipeline/graph.ts`): START → `download` (YouTube with no original) or `ingest`; `download` → `ingest` → `transcribe` → `match_record` → `understand_context`; `understand_context` → `ask_context`, or `match_record_late` when the card is `sufficient` or `round > MAX_CONTEXT_ROUNDS` (2); `ask_context` → `understand_context` on `continue`, `match_record_late` on `skip`, stays at `ask_context` otherwise; `match_record_late` → `name_speakers` → `index` → `analyze` → done. After every step except `index`/`analyze`, a session whose stage is `failed` stops.
- The node bodies keep their behaviour and stages/progress values (`setStage` calls, friendly error strings, `analyzeNode`'s crash guard). Only the LangGraph plumbing changes (`interrupt`, `Annotation`, `Command`, `StateGraph`).
- The web context route is unchanged: it moves `awaiting_context` → `understanding` (55, continue) or `naming_speakers` (60, skip) before sending `session.resume` with the payload.
- Concurrency is guarded in the database: advancing a run is compare-and-set on `next_step`; a runner that loses the CAS stops without writing.
- Job error handling stays in `onJobError` (deterministic → fail and return; transient → rethrow, fail on the final attempt).
- The human's context answers are user data: video retention deletes the `pipeline_runs` row (as it deleted the checkpoint thread).
- Worker relative imports use `.js`; core uses `.ts`. ffmpeg-touching tests run in the worker container.

## Review Focus

1. A duplicate `session.start` while the run is paused at `ask_context` (or after the web moved the stage to `understanding`): must not set the stage back to `awaiting_context` or re-run anything.
2. A retried `session.resume` after the answers were applied: must not append the answers twice or answer the next round's pause with the old payload.
3. A crash between a step's work and the CAS advance: the retry re-runs that step (all steps are idempotent today); nothing earlier re-runs.
4. A session that was mid-pipeline under LangGraph when this deploys (no `pipeline_runs` row, stage e.g. `transcribing` or `awaiting_context`): its retried job continues from the step matching its stage instead of starting over or doing nothing.
5. `ready`, `failed` and `uploaded`-but-already-finished sessions: a stray start job is a logged no-op.

---

### Task 1: `pipeline_runs` table and repo (core)

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Create: `packages/core/src/db/pipeline.ts`, `packages/core/src/db/pipeline.test.ts`
- Modify: `packages/core/src/server.ts` (export)
- Create: migration `packages/core/drizzle/0019_pipeline_runs.sql` (+ meta snapshot) via `pnpm --filter @digestor/core exec drizzle-kit generate`, then append by hand: `DROP TABLE IF EXISTS "checkpoint_writes", "checkpoint_blobs", "checkpoints", "checkpoint_migrations";`

**Interfaces:**
- Produces (core, `@digestor/core/server`):
  - `PIPELINE_STEPS = ["download","ingest","transcribe","match_record","understand_context","ask_context","match_record_late","name_speakers","index","analyze","done"] as const`; `type PipelineStep = typeof PIPELINE_STEPS[number]` (put the constant in client-safe `packages/core/src/schemas.ts` next to the stages).
  - `type PipelineRun = { sessionId: string; nextStep: PipelineStep; round: number; answers: { question: string; answer: string }[]; updatedAt: Date }`
  - `getPipelineRun(db, sessionId): Promise<PipelineRun | null>`
  - `ensurePipelineRun(db, sessionId, firstStep: PipelineStep): Promise<PipelineRun>` (insert on conflict do nothing, then select)
  - `advancePipelineRun(db, sessionId, from: PipelineStep, to: PipelineStep, patch?: { round?: number; answers?: PipelineRun["answers"]; stage?: { stage: Stage; progress: number } }): Promise<boolean>` (one transaction: `UPDATE pipeline_runs … WHERE next_step = from`, sets `updated_at = now()`; when it matched and `patch.stage` is given, sets the session's stage/progress the same way `setStage` does, in the same transaction)
  - `deletePipelineRun(db, sessionId): Promise<void>`
- Table `pipeline_runs`: `session_id uuid pk references sessions(id) on delete cascade`, `next_step text not null`, `round integer not null default 0`, `answers jsonb not null default '[]'`, `updated_at timestamptz not null default now()`.

- [ ] **Step 1: Failing tests** in `pipeline.test.ts` (TRUNCATE pattern of `names.test.ts`): `ensurePipelineRun creates once and returns the existing row the second time`; `advancePipelineRun moves only from the expected step` (`from` mismatch → `false`, row and session stage unchanged); `advance with a patch sets round and answers in the same update`; `advance with a stage patch sets the session stage only when the step moved`; `deletePipelineRun removes the row; deleting a session cascades`.
- [ ] **Step 2:** `pnpm --filter @digestor/core test pipeline` → FAIL (module missing).
- [ ] **Step 3:** Implement schema, repo, migration; `pnpm db:migrate` on the dev DB.
- [ ] **Step 4:** `pnpm --filter @digestor/core test` and `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(core): pipeline_runs table for the step runner`.

### Task 2: The runner replaces the graph (worker)

**Files:**
- Create: `apps/worker/src/pipeline/run.ts` (move the node functions and helpers from `graph.ts` here; delete `graph.ts`)
- Move/rewrite: `apps/worker/src/pipeline/graph.test.ts` → `apps/worker/src/pipeline/run.test.ts`
- Modify: `apps/worker/src/jobs.ts`, `apps/worker/src/jobs.test.ts`, `apps/worker/src/main.ts`, `apps/worker/src/cleanup.ts`, `apps/worker/src/cleanup.test.ts`, any import of `./pipeline/graph.js` (`grep -rn "pipeline/graph" apps/worker`)

**Interfaces:**
- Consumes: Task 1's repo functions and `PipelineStep`.
- Produces:
  - `type PipelineDeps` (unchanged, now exported from `run.ts`).
  - Each step: `(deps, run: PipelineRun, resume?: ResumePayload) => Promise<StepResult>`, `type StepResult = { next: PipelineStep; round?: number; answers?: PipelineRun["answers"] } | { pause: true } | { stop: true }`. `stop` = the step set the session `failed` (today's `return {}` after a failed `setStage`, caught by `unlessFailed`).
  - `runPipeline(deps, sessionId, opts?: { resume?: ResumePayload }): Promise<"paused" | "done" | "stopped" | "ignored">`
  - `firstStepFor(session): PipelineStep`: `download` when `source === "youtube" && originalKey === null`, else `ingest`.
  - `stepForStage(stage): PipelineStep | null` for rows missing after the deploy: `downloading`→`download`, `preparing`→`ingest`, `transcribing`→`transcribe`, `understanding`→`understand_context`, `awaiting_context`→`ask_context`, `naming_speakers`→`name_speakers`, `indexing`→`index`, `finding_topics`/`finding_moments`/`writing_briefing`/`preparing_preview`→`analyze`, `ready`→`done`, `uploaded`→ first step, `failed`→ `null`.
  - `JobContext = { db; deps }` (no `graph`).

Runner rules (the algorithm; everything else follows today's nodes):
- No row: create it with `stepForStage(session.stage)`; `null` (failed) → return `"ignored"`. Exception: a **resume** with no row (a session paused under LangGraph, answered after the deploy; the web already moved it to `understanding`/`naming_speakers`) creates the row at `ask_context`, so the answers are applied, not dropped.
- `done` → `"ignored"` (log `already finished`).
- **The pause is written once, atomically with the advance:** advancing *into* `ask_context` passes `stage: { stage: "awaiting_context", progress: 55 }` in the CAS patch, so the step move and the stage change land together (a crash can't leave the row at `ask_context` with the stage still `understanding`). Then return `"paused"`.
- At `ask_context` without `opts.resume` (a duplicate or retried start): write nothing, log, return `"paused"`. It never touches the stage, so it can't undo the web's move to `understanding`/`naming_speakers`.
- At `ask_context` with `opts.resume`: apply it (today's `askContextNode` body minus `pause`) and advance with the new `answers` in the CAS patch. `opts.resume` while the row is at any other step: continue from that step without the payload (today's `invoke(null)` branch), but never apply the payload to a later `ask_context` (clear it after the first step).
- After each step: `advancePipelineRun(from, result.next, patch)`; CAS lost → log and return `"stopped"`.
- `understand_context` returns `round` in the patch; the branch after it reads the card and `run.round` as today.

- [ ] **Step 1: Port the tests first.** Rewrite `graph.test.ts` as `run.test.ts` with the same `describe`/`it` names and assertions. In `setup()` replace `graph`/`cfg`/`resume`/`interruptValue` with `start = () => runPipeline(deps, id)`, `resume = (p) => runPipeline(deps, id, { resume: p })`, `nextStep = async () => (await getPipelineRun(db, id))?.nextStep`, and "paused at the context check" = `nextStep() === "ask_context"` with stage `awaiting_context`. `getState(cfg).next` → `[await nextStep()]`. Add tests for Review Focus 1, 2, 4, 5:
  - `a duplicate start while the web has moved the stage to understanding leaves the stage alone and runs nothing`
  - `a retried resume after the answers were applied does not append them again` (answers length unchanged; one `context_card` call per round)
  - `a session left mid-pipeline by the old graph (no run row, stage transcribing) continues from transcribe` and `(stage awaiting_context) pauses, and a resume continues` and `(no row, web already moved the stage to understanding) a resume applies the answers`
  - `a start job for a ready or failed session is ignored`
  In `jobs.test.ts`, replace the stubbed-graph tests with ones on a stubbed `runPipeline` boundary only where they test `onJobError` (non-final attempt rethrows and keeps the stage, final attempt fails, deterministic error fails at once); drop "passes a Command". In `cleanup.test.ts`, replace the checkpointer with "retention deletes the pipeline_runs row".
- [ ] **Step 2:** `docker compose run --rm worker pnpm --filter @digestor/worker test run jobs cleanup` → FAIL (`run.ts` missing).
- [ ] **Step 3:** Implement `run.ts`; switch `jobs.ts` (`handleStart` → `runPipeline(ctx.deps, id)`, `handleResume` → `runPipeline(ctx.deps, id, { resume: job.payload })`, both inside the existing `try`/`onJobError`), `main.ts` (no `PostgresSaver`), `cleanup.ts` (`deletePipelineRun` where `deleteThread` was, same order: files → run row → index → `videoDeletedAt`).
- [ ] **Step 4:** `pnpm test:worker` and `pnpm typecheck` → all PASS (same count as `main` ± the ported/added tests; list the delta).
- [ ] **Step 5:** Commit `refactor(worker): own step runner instead of LangGraph`.

### Task 3: Remove the dependency, docs, real run

**Files:**
- Modify: `apps/worker/package.json` (remove `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`), `pnpm-lock.yaml` (`pnpm install` on the host)
- Modify: `CLAUDE.md` (worker line: "step runner (`src/pipeline/run.ts`, one human pause…)", retention line: "the pipeline run row" instead of "the LangGraph checkpoint", skills list), `README.md` (technique table row and architecture line), `docs/deploy.md` if it mentions checkpoints
- Rename: `.claude/skills/pgboss-langgraph-gotchas/` → `.claude/skills/pgboss-gotchas/`; keep the pg-boss section verbatim; replace the LangGraph section with "Pipeline runner" rules (CAS advance, pause only on arrival, resume applies only at `ask_context`, steps idempotent, run row is user data, `stepForStage` for rows missing after deploy); update its frontmatter `name`/`description` and the CLAUDE.md skills list.

- [ ] **Step 1:** `grep -rn "langgraph\|LangGraph\|checkpoint" apps packages CLAUDE.md README.md docs/deploy.md .claude/skills` (excluding `node_modules`, historical specs/plans) → list every hit; each one is changed or justified in the report.
- [ ] **Step 2:** Remove the deps, `pnpm install`, `docker compose restart worker`; `pnpm test`, `pnpm typecheck`, `pnpm test:worker` → all PASS; the worker log shows it started.
- [ ] **Step 3: Real run (controller, paid, a few cents):** upload a short (≈2–5 min) real speech video through `/new` with the owner's `.env` (OpenRouter, Haiku 5.5). Expected: Processing → context check (pause) → Continue with one answer → `ready`; the `pipeline_runs` row ends at `done`; then delete that session and its files (cleanup-test-leftovers rule).
- [ ] **Step 4:** Commit `chore: drop LangGraph; docs and pg-boss skill for the step runner`.
