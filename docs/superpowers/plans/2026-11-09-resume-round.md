# Resume Round + Runner Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A context-check answer is applied only to the question round it answered, and the step runner gets a database check on its step names plus the test gaps left by the LangGraph swap and the duplicate-persons fix.

**Architecture:** The web context route stamps `session.resume` jobs with the round of the stored context card it answered; the runner applies a resume only when that round equals the run row's round (jobs without a round keep today's stage guard). A migration adds a CHECK constraint on `pipeline_runs.next_step`.

**Tech Stack:** TypeScript, Next.js route handlers, pg-boss 12, Drizzle, vitest.

**Spec:** no spec doc. Source: the owner's request on 2026-11-09 ("fix the following: the round race … tag each answer with its round; a database check on the step names, and a few test gaps") and the deferred items in the replace-langgraph and duplicate-persons ledgers. Branch `resume-round` from `main` 192463e.

## Global Constraints

- The web API contract is unchanged: the browser keeps sending `ResumePayload` (`continue` with answers/cardEdits, or `skip`); the route adds the round server-side from `getContextCard(db, id).round`.
- `ResumeJob` gains an optional `round: number` (int ≥ 1). Optional, so jobs queued before the deploy still validate.
- Runner rule (`apps/worker/src/pipeline/run.ts`): at `ask_context`, a resume whose `round` is set and differs from `run.round` is stale → log and return `"paused"` without writing. A resume without `round` keeps today's stage guard (`awaiting_context` → stale). A matching round is applied even if a crash happened after a previous application (steps are idempotent).
- `pipeline_runs.next_step` gets `CHECK (next_step IN (…PIPELINE_STEPS…))` in migration `0020_pipeline_steps_check`; the list must equal `PIPELINE_STEPS` in `packages/core/src/schemas.ts` exactly.
- Concurrency stays in the database (CAS on `next_step`); job error handling stays in `onJobError`.
- Never run the host suite and the worker suite at the same time (core truncates the shared `digestor_test`).

## Review Focus

1. A redelivered round-1 resume arriving after the run has moved into round 2's pause, and after the journalist has already sent round 2 (stage `understanding`): round 1's answers must not be applied; round 2's job then applies.
2. A round-1 resume retried after a crash *inside* `ask_context` (row still at `ask_context`, round 1): it must still apply (same round).
3. A resume job without `round` (queued before the deploy): behaves exactly as today.
4. The route when the context card is missing (shouldn't happen at `awaiting_context`): the route must not crash with a raw 500; send without a round (fallback) or answer a friendly 409 — pick one and test it.
5. The CHECK constraint's value list drifting from `PIPELINE_STEPS`: a test reads the allowed values from the database and compares them to `PIPELINE_STEPS`.

---

### Task 1: Tag resume jobs with their round

**Files:**
- Modify: `packages/core/src/queue.ts` (`ResumeJobSchema`), its test `packages/core/src/queue.test.ts`
- Modify: `apps/web/app/api/sessions/[id]/context/route.ts`, test `apps/web/app/api/sessions/context.test.ts`
- Modify: `apps/worker/src/jobs.ts` (`handleResume` passes `job.round`), `apps/worker/src/pipeline/run.ts` (`runPipeline` opts gain `round?: number`), tests `apps/worker/src/jobs.test.ts`, `apps/worker/src/pipeline/run.test.ts`
- Modify: `.claude/skills/pgboss-gotchas/SKILL.md` (runner section: resume rule now round-first, stage guard as fallback)

**Interfaces:**
- Produces: `ResumeJobSchema = z.object({ sessionId, payload: ResumePayloadSchema, round: z.number().int().positive().optional() })`; `runPipeline(deps, sessionId, opts: { resume?: ResumePayload; round?: number })`.

- [ ] **Step 1: Failing tests**
  - core `queue.test.ts`: `ResumeJobSchema accepts a round and accepts a job without one; rejects round 0`.
  - web `context.test.ts`: `continue sends session.resume with the stored card's round` (card saved with round 2 → sent job has `round: 2`); `skip sends the round too`; Review Focus 4 case per your choice.
  - worker `run.test.ts` (describe `runner`): `a redelivered round-1 resume after round 2 was answered is ignored; round 2's resume applies` (RF1: drive the real runner to round 2's pause, web-move the stage to understanding, run a resume with round 1 → `"paused"`, answers unchanged, no context call; then round 2 → applied); `a round-1 resume retried after a crash inside ask_context still applies` (RF2); `a resume without a round behaves as before` (RF3: reuse an existing stage-guard test with no round).
  - worker `jobs.test.ts`: `handleResume passes the job's round to runPipeline`.
- [ ] **Step 2: Run** core `pnpm --filter @digestor/core test queue`, web `pnpm --filter @digestor/web test context`, worker (container) `docker compose run --rm worker pnpm --filter @digestor/worker test run jobs` → the new tests FAIL.
- [ ] **Step 3: Implement** the schema field, the route stamp (read `getContextCard` after the stage CAS), `handleResume` → `runPipeline(ctx.deps, id, { resume: job.payload, round: job.round })`, and the runner rule from Global Constraints; update the skill's runner rule.
- [ ] **Step 4: Run** `pnpm test`, then `pnpm typecheck`, then `pnpm test:worker` (one after another) → all PASS.
- [ ] **Step 5: Commit** `fix(runner): apply a context answer only to the round it answered`.

### Task 2: Step-name CHECK and test gaps

**Files:**
- Create: migration `packages/core/drizzle/0020_pipeline_steps_check.sql` (+ meta) — the CHECK; declare it in `packages/core/src/db/schema.ts` (`check()` on `pipelineRuns`) so drizzle's snapshot knows it, building the list from `PIPELINE_STEPS`.
- Modify: `packages/core/src/db/pipeline.ts` (`ensurePipelineRun`: a descriptive error instead of the non-null assertion), `packages/core/src/db/pipeline.test.ts`
- Modify: `packages/core/src/db/names.test.ts`

- [ ] **Step 1: Failing tests**
  - `pipeline.test.ts`: `the database refuses an unknown next_step` (raw insert/update with `'bogus'` throws a check violation); `the CHECK's allowed values equal PIPELINE_STEPS` (RF5: read the constraint from `pg_constraint` / `information_schema.check_constraints` and compare to `PIPELINE_STEPS`); extend the mismatch test: `a CAS from the wrong step leaves round and answers untouched even with a patch`; rename the test "advance with a stage patch sets the session stage only when the step moved" to what it checks (moved case), keeping the not-moved assertion in the mismatch test; `ensurePipelineRun throws a clear error when the row is gone after the insert` (e.g. delete the session between calls via a db proxy, or test the helper's error path directly).
  - `names.test.ts`: `findPersonByName returns the official row when an older unfolded custom row has the same name` — two officials of the same name (homonym guard keeps the custom row unfolded) plus an OLDER custom row; `findPersonByName` must return an official row, not the custom one. Run it against a build of `findPersonByName` without the official-first sort to show it fails (record the RED: temporarily remove the sort, run, restore).
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test pipeline names` → new tests FAIL (except the rename).
- [ ] **Step 3: Implement**; generate the migration with drizzle-kit (next number 0020); apply to the dev DB with `pnpm db:migrate` (approved; check first that every `pipeline_runs.next_step` in the dev DB is a valid step).
- [ ] **Step 4: Run** `pnpm test`, then `pnpm typecheck`, then `pnpm test:worker` → all PASS.
- [ ] **Step 5: Commit** `chore(runner): CHECK on next_step; test gaps`.
