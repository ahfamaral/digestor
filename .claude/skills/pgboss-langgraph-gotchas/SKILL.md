---
name: pgboss-langgraph-gotchas
description: Version-pinned pitfalls of pg-boss 12 and LangGraph JS 1.x (StateGraph, interrupt/Command, Postgres checkpointer) as used in Digestor's worker, with the patterns that fixed them. Read this before writing or changing anything that sends or handles jobs, creates queues, schedules work, retries, resumes a paused pipeline, adds a graph node or interrupt, deletes session data, or tests crash/restart behaviour — including Plan 2 work like the copilot's tool calls if they enqueue jobs or touch the graph. Use it even when the change looks small ("just add a queue", "just add a node") because almost every bug here looked small.
---

# pg-boss + LangGraph: what bit us

Versions this was verified against: `pg-boss` 12.38, `@langchain/langgraph` 1.5, `@langchain/langgraph-checkpoint-postgres` 1.1. If `pnpm-lock.yaml` shows a newer major, re-check each item against `node_modules/<pkg>/dist/*.d.ts` before relying on it.

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

## LangGraph

1. **`invoke(input, cfg)` on an existing thread starts over from START.** To continue a crashed or retried run, check `const state = await graph.getState(cfg)`: if `state.next.length > 0`, call `graph.invoke(null, cfg)`. Fresh start only when nothing is pending (`handleStart`).

2. **Resume an interrupt only if one is pending.** `new Command({ resume })` sent when the graph is mid-run or at a *later* interrupt would answer the wrong question. `handleResume` branches three ways: pending interrupt (`state.tasks[].interrupts`) → `Command`; `next` non-empty without interrupt → `invoke(null)`; finished → log and ignore.

3. **A node re-runs from its first line when resumed.** Everything before `interrupt()` executes again, and `interrupt()` then returns the resume value. So side effects before an interrupt must be idempotent, and the "awaiting" stage must only be written on the *real* pause, not on the replay — otherwise it overwrites the stage the API just set (`pause()` in `graph.ts`).

4. **Every node must be safe to run twice** (retry after a crash re-runs the interrupted node): `replaceAiClips` replaces instead of appending; the render node skips clips already `done` and survives a single clip failing.

5. **State channels need reducers/defaults** (`Annotation.Root` with `reducer` + `default`); conditional edges read state *and* the DB — keep the round/limit logic in one place (`MAX_CONTEXT_ROUNDS`).

6. **Checkpoints are user data.** They hold the human's answers. Deleting a session means `checkpointer.deleteThread(sessionId)` too (`runVideoRetention`: video files → checkpoints → `videoDeletedAt`, so a failure leaves the session for the next run; rows, thumbnails and `clips/` are kept). Thread id = session id.

7. **`PostgresSaver.fromConnString(url)` then `await saver.setup()`** once at startup; tests use `MemorySaver`.

## Testing these paths

- Use the real graph with `MemorySaver`, `FakeLLM` and a fake transcriber; don't stub `getState` — stubs hid resume bugs. Pattern: `graph.test.ts` "crash/resume" test — attempt 0 throws inside a node, attempt 1 (`handleStart` again) must resume from the checkpoint, not redo finished nodes, and not duplicate clips; a duplicate start afterwards is a no-op.
- For job handlers, cover: non-final attempt (stage untouched, rethrows), final attempt (failed), deterministic error (failed at once, no rethrow).
- pg-boss behaviour itself (expiry, heartbeat) is checked against the dev DB: `select name, retry_limit, expire_seconds, heartbeat_seconds from pgboss.queue;` and the same columns on a freshly sent row in `pgboss.job`.
- Worker tests run in the container: `docker compose run --rm worker pnpm --filter @digestor/worker test <pattern>`.
