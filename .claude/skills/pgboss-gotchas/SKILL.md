---
name: pgboss-gotchas
description: Version-pinned pitfalls of pg-boss 12 and the rules of Digestor's own pipeline step runner (Postgres-backed position, compare-and-set advance, the context-check pause, resume, retries) as used in the worker, with the patterns that fixed them. Read this before writing or changing anything that sends or handles jobs, creates queues, schedules work, retries, resumes a paused pipeline, adds or changes a pipeline step or pause, deletes session data, or tests crash/restart behaviour — including Ask tool calls if they enqueue jobs. Use it even when the change looks small ("just add a queue", "just add a step") because almost every bug here looked small.
---

# pg-boss and the pipeline runner: what bit us

Version this was verified against: `pg-boss` 12.38. If `pnpm-lock.yaml` shows a newer major, re-check each item against `node_modules/<pkg>/dist/*.d.ts` before relying on it.

Every item below cost a review round on Plan 1. The code that implements each fix is named so you can copy the pattern instead of re-deriving it.

## pg-boss

1. **`createQueue` does nothing on a queue that already exists.** Changing options in code silently doesn't reach existing databases. Call `updateQueue(name, opts)` right after `createQueue` (see `apps/worker/src/main.ts`).

2. **`singletonKey` does not dedupe on standard queues.** It only works with a singleton/stately queue `policy`. Ours are standard, so a double click sends two jobs. Dedupe in the database instead: an atomic compare-and-set before sending — `transitionStage(db, id, from, to)` for stage changes, `claimClipRender` for renders — and send only when it returned `true`. `singletonKey` stays as defence in depth, never as the guarantee.

3. **One source of job options.** `JOB_OPTIONS` in `packages/core/src/queue.ts` (`retryLimit: 2, retryDelay: 30, expireInSeconds: 43200, heartbeatSeconds: 60`) is applied to every queue (create + update) *and* spread into every `send`. New queue or new sender → use it; don't hand-write options.

4. **The default expiry is 15 minutes.** A long transcription or render past `expireInSeconds` is marked expired and *retried while the first run is still going* — two workers on one session. Long-running work needs a long expiry (we use 12 h).

5. **Without a heartbeat, a hard crash strands the job.** `kill -9`, OOM or a VPS reboot leaves the job `active` until it expires. With `heartbeatSeconds`, pg-boss refreshes the heartbeat while the handler runs and retries the job a minute after the worker dies. A *graceful* `boss.stop()` already calls `failWip()`, so those jobs retry after `retryDelay`.

6. **Attempt metadata needs `includeMetadata: true`** in the `work` options. Only then do jobs carry `retryCount` / `retryLimit`. Attempts are `retryCount` 0, 1, 2 with `retryLimit` 2 — the final attempt is `retryCount >= retryLimit`.

7. **Throw = retry, return = complete.** So:
   - deterministic errors (missing API key, vendor rejected the file, invalid payload) → record the failure and **return** — retrying can't help and costs money;
   - transient errors → **rethrow**, and only mark the session `failed` on the final attempt. Marking it failed earlier makes the UI show "Start over" while a retry is about to succeed. See `onJobError` in `apps/worker/src/jobs.ts`.

8. **Handlers receive an array** (even with `batchSize: 1`); validate each payload with zod and complete garbage instead of throwing (`processJobs`).

9. **`schedule(name, cron, data, { tz })` needs the queue to exist first**, and the schedule lives in the DB — renaming a cron queue leaves the old schedule behind.

10. **Final-attempt crash is covered by the sweep.** If the last attempt dies without its handler finishing, nothing in the handler marks the session failed. `sweepStaleSessions` (`apps/worker/src/sweep.ts`, queue `session.sweep`, every 15 min) fails sessions in a processing stage with no `created`/`retry`/`active` job in `pgboss.job` for 120 min, and likewise any `running` analysis version with no live job. Keep new job queues that own a session in `LIVE_JOB_QUEUES` there. Rows a job owns are covered too (`sweepStaleJobRows`, R32): translations `pending`, tracks `preparing`, renders and burns `queued`/`rendering` untouched for 30 min with no live job matched on `data->>'analysisId'`/`'language'`, `'trackId'` or `'clipId'` are failed (friendly text in `error` where the row has one). A new job-owned row status belongs there, and its table needs an `updated_at` the sweep can age.

## Pipeline runner

`apps/worker/src/pipeline/run.ts` (`runPipeline`, `firstStepFor`, `stepForStage`); position in `pipeline_runs` (`next_step`, `round`, `answers`).

1. **The run row's `next_step` is the position.** Each step returns the next step (or a pause/stop); the runner advances with `advancePipelineRun`, a compare-and-set on `next_step`. A runner that loses the CAS stops without writing.

2. **The pause stage is written exactly once.** Advancing INTO `ask_context` writes `awaiting_context` (55) in the same transaction as the CAS (the optional stage patch is applied only when the CAS matched). A start or duplicate start that finds the row at `ask_context` writes nothing, so it can't overwrite the stage the API set.

3. **Resume applies only at `ask_context`, and only to the round it answered.** The web route stamps the job with the stored card's round (`ResumeJob.round`); a resume whose round differs from the run's `round` is stale (a redelivered round-1 job after round 2 was answered) and returns `"paused"` without writing, while a retry inside the same round still applies (steps are idempotent). A job without `round` (queued before the deploy, or no card at the route) falls back to the stage guard: a resume that arrives while the stage still says `awaiting_context` is stale. The payload is used for that one step only, never stored as a position.

4. **Every step must be safe to run twice.** A crash before the CAS re-runs that step only: `replaceAiClips` replaces instead of appending; `analyze` returns early when the analysis already exists.

5. **The run row is user data.** It holds the human's answers. Retention deletes it (`runVideoRetention`: video files → run row → search index → `videoDeletedAt`, so a failure leaves the session for the next run; rows, thumbnails and `clips/` are kept).

6. **A session with no row** (left by the old LangGraph worker, or seeded) gets one from `stepForStage(session.stage)`. A resume with no row starts at `ask_context` (round from the stored card) only when the stage is `awaiting_context`, `understanding` or `naming_speakers` (`ANSWERED_STAGES`); otherwise `stepForStage`. `ready`, `failed` and `done` are a logged no-op. `scripts/seed-demo.ts` writes a `done` row so a seeded session never runs paid steps.

## Testing these paths

- Use the real runner with `FakeLLM` and `FakeTranscriber` against `digestor_test`; don't stub the run row or the repo functions — stubs hid resume bugs. Pattern: `run.test.ts` crash/resume test — attempt 0 throws inside a step, attempt 1 (`handleStart` again) must continue from `next_step`, not redo finished steps, and not duplicate clips; a duplicate start afterwards is a no-op.
- For job handlers, cover: non-final attempt (stage untouched, rethrows), final attempt (failed), deterministic error (failed at once, no rethrow).
- pg-boss behaviour itself (expiry, heartbeat) is checked against the dev DB: `select name, retry_limit, expire_seconds, heartbeat_seconds from pgboss.queue;` and the same columns on a freshly sent row in `pgboss.job`.
- Worker tests run in the container: `docker compose run --rm worker pnpm --filter @digestor/worker test <pattern>`.
- Never run the host suite (`pnpm test`) and the worker suite at the same time: core truncates the shared `digestor_test` database.
