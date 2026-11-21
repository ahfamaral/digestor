# AI goes first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ask the entry point of the journalist flow: a goal typed at upload starts Ask when the video is ready, Ask opens docked beside the Briefing and on Prepare, it can see, change and replace existing clips, it asks one clarifying question with quick replies, and an approval card never overwrites a manual edit.

**Architecture:** Branch `ai-goes-first` from `main` 6fdc72a. One migration adds `sessions.goal` and `clips.edit_version`. The question-plus-pending-answer insert of `POST /api/sessions/[id]/ask` moves into one core function (`startAskQuestion`) that the route and a new worker hook (`startGoalAsk`, called after the start, resume and preview-copy jobs) both use; the pipeline steps themselves are not touched. Four new Ask tools (`list_clips`, `get_clip_context`, `update_clip`, `replace_clip`) and a terminal `ask_user` live in `apps/worker/src/agents/ask.ts` beside the existing ones; each clip-changing card records the clips' edit versions and is refused (route pre-check plus a compare-and-set at apply time) when one changed. On the web, `AskDrawer` splits into `AskThread` (the conversation) and the frame; a small dock hook decides whether it opens docked.

**Tech Stack:** TypeScript (strict, ESM), pnpm monorepo, Next.js 16 (App Router), Drizzle + Postgres, pg-boss, LangGraph (`@langchain/langgraph`) with `PostgresSaver`, zod 4, Vitest (real Postgres via `TEST_DATABASE_URL`), shadcn / Base UI, Playwright through the `digestor-run` skill.

**Spec:** `docs/superpowers/specs/2026-11-21-ai-goes-first-design.md` (copied in Task 1 from the approved scratch copy). Read it and `CLAUDE.md` ("Conventions that bite", "Workflow") before any task.

## Global Constraints

- **Build starts only when the owner says "banana"** in chat; give a time estimate first (CLAUDE.md Workflow). Approving this plan is not the go signal.
- Work only on branch `ai-goes-first`. Never merge to `main`, push, or touch production. Production deploy happens only after every "Done when" item passes **and the owner's explicit permission in chat** (Task 15).
- Commits: CLAUDE.md says "Commit only when asked". The per-task commit steps assume the owner's "banana" covers this plan's commits; confirm that once at kick-off, and if not, stage nothing and keep the commit messages for later. `git add` explicit paths only, never `.env`, `data/`, `node_modules`, `.pnpm-store`, `apps/worker/eval/results/`. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Owner decisions (spec): Approach A only; **the AI proposes, the journalist decides**; work started in chat can always be continued by hand and the reverse; nothing the agent makes lives outside the normal Briefing / Prepare / Export data.
- `sessions.goal`: nullable, at most **500 characters** (the Ask question cap), separate from `sessions.hint` (2,000, the context agent's input). Empty goal = today's behaviour exactly.
- Ask limits unchanged: approval card before any change, `MAX_DIRECT_CHANGES` stays **3**, sentence snapping (`snapRange` / `snapEdges`). `update_clip` and `replace_clip` count as **one change each**. `MUTATING_TOOLS` becomes `propose_clip`, `trim_clip`, `set_selection`, `make_clip_package`, `update_clip`, `replace_clip`.
- `get_clip_context`: default **60 s** each side, at most **180 s**. `ask_user`: **2–4 options**, at most one question before acting.
- Edit version (`clips.edit_version`, integer, default 0) is bumped **only** by changes to start/end, format, crop, title, credit (and its "no credit needed" switch), subtitle languages added or removed. Renders, checks, acknowledgements and subtitle cue edits never bump it. `updated_at` is never used for staleness.
- Clip numbers are **exactly Prepare's**: `listClips` order (`startMs`, `createdAt`, `id`), 1-based, live clips only.
- Non-goals: no Studio screen, no chat home page, no goal-steered analysis, no token streaming, no new model, no change to `askLibrary`, sign-in, or the Câmara monitor.
- Anti-goals: no manual path gets harder or hidden (stepper, Briefing filters, Approve / Skip, "Prepare clips", Prepare and Export unchanged when Ask is closed or the goal is empty); no change without an approval card; no silent overwrite of a manual edit; no phone sheet over the page on arrival; no change to the monitor, the pipeline steps (`pipeline/run.ts` step functions, `analysis.ts`, `proxy.ts`) or the context check.
- Migration: one Drizzle migration, `0036_ai_goes_first` today (`main` ends at 0035). If `main` gains migrations (sign-in) before this merges, delete it and its snapshot and regenerate with the next number after rebasing.
- Copy only in `apps/web/messages/en.ts` (`t()`); friendly sentences; follow the `digestor-ui` skill (tokens, keyboard, focus, labels, touch targets). Paid one-click actions state their cost (core `cost.ts`).
- Transcript-derived text in new tool output (moment titles, transcript) goes through `evidence()` (R31).
- Skills to read before the matching work: `digestor-ui` (Tasks 3, 9, 10), `nextjs16-gotchas` (Tasks 3, 4, 6, 9, 10), `pgboss-gotchas` (Tasks 4, 7, 8), `digestor-run` (Tasks 1, 14).
- Every task ends green: `pnpm typecheck`, `pnpm test`, and `pnpm test:worker` when worker or core code changed. Worker tests run in the container only (never ffmpeg/yt-dlp on the host).
- The owner's real sessions (`7433d1c6…` Globo debate, `f2fce3ea…`, `b3e26a69…`, `a8037dcf…`) are never deleted, re-analysed or given Ask messages by tests or scripts.

## Review Focus

1. **A goal on a session that never becomes ready, or waits days at the context check.** Expect no Ask message until `ready`, none ever for a `failed` session, and the goal still starting once the context answer finally lets it finish. Test owned by Task 4 (`startGoalAsk skips a session that isn't ready, and starts once it is`).
2. **A card with two changes, or a manual trim landing between the route's check and the worker's write.** Expect nothing applied from the card: not one change applied and one refused. Tests owned by Task 6 (`a card with two calls applies neither when one clip went stale`, `a manual trim after the route's check is still refused at apply time`).
3. **Undo of an Ask replace after the journalist edited that clip by hand.** Expect the Ask chip's Undo to refuse ("There is nothing to undo.") and the manual edit to stay. Prepare's own Undo first reverts the manual edit, then the replace. Test owned by Task 8 (`the Ask chip's undo leaves a later manual edit alone`).
4. **Clip numbers drifting after a merge, an undone creation or a trim that reorders clips.** Expect `list_clips` to number exactly what Prepare shows at that moment, with absorbed and deleted clips taking no number. Test owned by Task 5 (`list_clips numbers what Prepare shows after a merge and a reorder`).
5. **Quick-reply buttons on an older question, or clicked twice.** Expect only the latest answer's options to show as buttons, disabled while a question is being sent. An older question shows its options as plain text. Test owned by Task 9 (`only the last answer's options are buttons`).

---

### Task 1: Branch, spec and plan in the repo, "before" recording

**Files:**
- Create: `docs/superpowers/specs/2026-11-21-ai-goes-first-design.md` (copy of the approved spec)
- Create: `docs/superpowers/plans/2026-11-21-ai-goes-first.md` (copy of this plan)

- [ ] **Step 1: Wait for "banana".** Give the owner a time estimate (all tasks: about one long evening plus the end-to-end run), then wait for the word.
- [ ] **Step 2: Branch.** `git -C ~/Projects/gh-projects/turing-college/capstone switch -c ai-goes-first main` (check `git log -1 --oneline main` is `6fdc72a` or note the newer head).
- [ ] **Step 3: Copy the two documents.** Copy the scratch spec `digestor-ai-first-design.md` to the spec path and this plan to the plan path, byte for byte (`cp`). In the spec copy, change only its line "To be committed as … when the build starts" to "Committed on branch `ai-goes-first` (21 Nov)".
- [ ] **Step 4: "Before" recording.** With the `digestor-run` skill, on this unchanged branch, record a 30–60 s Playwright video (`recordVideo`) of today's flow: `/new` → an analysed session's Briefing → press `/` → Ask drawer. Save it to git-ignored `reports/ai-goes-first/before.webm`. Use a seeded demo session (`scripts/seed-demo.ts --stage ready`), not an owner session.
- [ ] **Step 5: Commit.**

```bash
git add docs/superpowers/specs/2026-11-21-ai-goes-first-design.md docs/superpowers/plans/2026-11-21-ai-goes-first.md
git commit -m "docs: AI goes first spec and plan"
```

---

### Task 2: Migration, edit version and stale-card check (core)

**Files:**
- Modify: `packages/core/src/db/schema.ts` (`sessions.goal`, `clips.editVersion`)
- Create: `packages/core/drizzle/0036_ai_goes_first.sql` + `meta/` (generated)
- Modify: `packages/core/src/personalTypes.ts`, `packages/core/src/db/personal.ts`, `packages/core/src/db/repo.ts` (`createSession` input), `apps/web/app/api/clips/[id]/tracks/route.ts` (`createOrRetry` passes `rebuild`)
- Test: `packages/core/src/db/personal.test.ts`, `packages/core/src/db/repo.test.ts`

**Interfaces:**
- Produces:
  - `sessions.goal: text("goal")` (nullable). `Session` (inferred) gains `goal: string | null`. `createSession(db, { …, goal?: string | null })`.
  - `clips.editVersion: integer("edit_version").notNull().default(0)`. `Clip.editVersion: number`.
  - `ClipEventKind` = `"create" | "bounds" | "format" | "style" | "delete" | "merge" | "update" | "replace"` (the last two are written in Tasks 7–8).
  - `interface CardClip { id: string; n: number; version: number }` and `interface StaleClip { n: number; removed: boolean }` in `personalTypes.ts`. `ToolApprovalCall.clips?: CardClip[]`. `ToolApprovalResolution.stale?: StaleClip[]`.
  - `class StaleClipError extends Error { constructor(readonly clipId: string) }`.
  - `updateClip(db, id, patch, actor, opts?: { expectVersion?: number }): Promise<Clip>`: throws `StaleClipError` when `expectVersion` is given and the locked row's `editVersion` differs, or the clip is deleted.
  - `createTrack(db, clipId, language, opts?: { rebuild?: boolean }): Promise<Track | null>`: bumps the clip's version when it inserts, unless `rebuild`. `deleteTrack` bumps when it deletes.
  - `staleCardClips(db: Db, ownerId: string, clips: CardClip[]): Promise<StaleClip[]>`: one entry per card clip that is gone, deleted, not this owner's, or whose `editVersion !== version`, in card order.

- [ ] **Step 1: Write the failing tests** (in `personal.test.ts`, new `describe("edit version")`, reusing the file's session/clip seeding helpers):

```ts
it("bounds, format, crop, credit and no-credit changes bump the edit version once each", async () => {
  // createClip → 0; updateClip {startMs,endMs} → 1; {format} → 2; {cropOffset} → 3; {credit} → 4; {noCreditNeeded:true} → 5
  expect((await getClip(db, c.id))!.editVersion).toBe(5);
});
it("renders, acknowledgements, subtitle style and cue edits don't bump it", async () => {
  // updateClip {warningsAck:true}, {protectedAck:true}, {subtitleStyle:"white"}; claimClipRender/finishClipRender; editTrackCues
  expect((await getClip(db, c.id))!.editVersion).toBe(before);
});
it("merge bumps the survivor; undo of bounds or format bumps again", async () => { /* survivor +1; undoLastEvent +1 */ });
it("a new subtitle language bumps it, a rebuild of the same language doesn't, a rolled-back track does", async () => {
  // createTrack(en) → +1; deleteFailedTrack + createTrack(en, { rebuild: true }) → +0; createTrack(pt) then deleteTrack → +2
});
it("updateClip with a different expectVersion throws StaleClipError and changes nothing", async () => {
  await expect(updateClip(db, c.id, { startMs: 1000 }, "ask", { expectVersion: c.editVersion + 1 })).rejects.toBeInstanceOf(StaleClipError);
  expect((await getClip(db, c.id))!.startMs).toBe(c.startMs);
});
it("staleCardClips names changed and removed clips by their card number", async () => {
  // card [{id:a,n:1,version:0},{id:b,n:2,version:0},{id:gone,n:3,version:0}]; trim b; deleteClip(gone)
  expect(await staleCardClips(db, OWNER_ID, card)).toEqual([{ n: 2, removed: false }, { n: 3, removed: true }]);
});
```

and in `repo.test.ts`: `it("createSession stores the goal, null when not given")`.

- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @digestor/core test personal repo` → FAIL (`editVersion` undefined, `staleCardClips` not exported).
- [ ] **Step 3: Schema and migration.** Add both columns, then `pnpm --filter @digestor/core db:generate --name ai_goes_first`. The SQL must be exactly two `ALTER TABLE … ADD COLUMN` statements (`"goal" text`, `"edit_version" integer DEFAULT 0 NOT NULL`). Run `pnpm db:migrate` against the dev DB.
- [ ] **Step 4: Implement the bumps and checks.** In `updateClip`, set `edit_version = edit_version + 1` in the same update when `boundsChanged || formatChanged || creditChanged` (credit includes `noCreditNeeded`), and check `expectVersion` right after `lockClip`. Add the same bump to `mergeClips` (survivor), `undoLastEvent` (every kind it reverts), `createTrack` (unless `rebuild`) and `deleteTrack` (when a row was deleted), each in one transaction with its write. `staleCardClips` reads the clips with `getClipAny`. In `apps/web/app/api/clips/[id]/tracks/route.ts`, pass `{ rebuild: true }` to the second `createTrack` in `createOrRetry`.
- [ ] **Step 5: Run the tests to verify they pass.** `pnpm --filter @digestor/core test personal repo` → PASS. Then `pnpm typecheck && pnpm test && pnpm test:worker` (existing suites unchanged).
- [ ] **Step 6: Commit.** `git add` the schema, migration SQL and meta, `personalTypes.ts`, `personal.ts`, `repo.ts`, both tests, the tracks route; `git commit -m "feat(core): sessions.goal and clips.edit_version (migration 0036), stale-card check"`.

---

### Task 3: Goal at upload

**Files:**
- Create: `apps/web/lib/goalInput.ts`, `apps/web/lib/goalInput.test.ts`
- Modify: `apps/web/app/api/sessions/upload/route.ts`, `apps/web/app/api/sessions/youtube/route.ts`, `apps/web/components/UploadForm.tsx` (the confirm's `estimate` at lines ~208–213), `apps/web/messages/en.ts`
- Test: `apps/web/app/api/sessions/upload/route.test.ts`, `apps/web/app/api/sessions/youtube/route.test.ts`, `apps/web/components/UploadForm.test.tsx` (new)

**Interfaces:**
- Consumes: `createSession(db, { goal })` (Task 2).
- Produces: `GOAL_MAX_CHARS = 500`; `readGoalInput(raw: string | null | undefined): { goal: string | null } | { error: Response }` (trimmed; blank → null; over 500 → 400 `t("upload.goalTooLong")`). Upload takes `&goal=` in the query string; YouTube takes `goal` in the JSON body.

Copy (en.ts, `upload.*`): `goalLabel` "What do you want from this video?", `goalOptional` "(optional)", `goalPlaceholder` "e.g. 'Three short clips about education, with English subtitles, for social media'", `goalHelp` "Ask starts on it as soon as the video is ready. Leave it empty to work by hand.", `goalChip.instagram` "3 clips for Instagram", `goalChip.heated` "The heated exchanges", `goalChip.speaker` "Everything one speaker says about a topic", `goalTooLong` "Keep the goal to 500 characters or fewer.". `cost.uploadGoal` "Ask will then start on your goal: about {cost} more." (`{cost}` = `aboutUsd(ASK_USD_PER_QUESTION)`, core `cost.ts`, appended to the confirm's `estimate`).

- [ ] **Step 1: Write the failing tests.**

```ts
// goalInput.test.ts
it("trims, turns blank into null and refuses more than 500 characters", async () => {
  expect(readGoalInput("  3 clips  ")).toEqual({ goal: "3 clips" });
  expect(readGoalInput("   ")).toEqual({ goal: null });
  expect(readGoalInput("x".repeat(500))).toEqual({ goal: "x".repeat(500) });
  const r = readGoalInput("x".repeat(501)); expect("error" in r && r.error.status).toBe(400);
});
// upload/route.test.ts and youtube/route.test.ts
it("stores the goal apart from the hint", /* goal=…&hint=… → session.goal and session.hint each as sent */);
it("an empty goal stores null", /* no goal param → goal null */);
it("a goal over 500 characters is a friendly 400 and creates no session", /* body.error === t("upload.goalTooLong") */);
// UploadForm.test.tsx (vi.mock("next/navigation") as ContextCheck.test.tsx does; renderToStaticMarkup)
it("shows the goal field above the optional details, with three chips", () => {
  const html = renderToStaticMarkup(<UploadForm /* existing props */ />);
  expect(html.indexOf("What do you want from this video?")).toBeLessThan(html.indexOf("Anything we should know?"));
  expect(buttons(html)).toEqual(expect.arrayContaining(["3 clips for Instagram", "The heated exchanges", "Everything one speaker says about a topic"]));
});
```

- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @digestor/web test goalInput upload youtube UploadForm` → FAIL.
- [ ] **Step 3: Implement.** `goalInput.ts` follows `hintInput.ts`. Both routes read the goal next to the hint and pass it to `createSession`. `UploadForm`: a new card above the hint card with a labelled `Textarea` (`maxLength={GOAL_MAX_CHARS}`, `aria-describedby` the help line), then the three chips as `type="button"` buttons that **replace** the field's text and focus it. The upload confirm dialog adds `cost.uploadGoal` only when the goal is not blank.
- [ ] **Step 4: Run to verify they pass**, then `pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** (`feat(upload): optional goal for Ask`).

---

### Task 4: One way to start an Ask answer; the goal starts it when the video is ready

**Files:**
- Modify: `packages/core/src/db/personal.ts` (`startAskQuestion`), `apps/web/app/api/sessions/[id]/ask/route.ts`
- Create: `apps/worker/src/goalAsk.ts`, `apps/worker/src/goalAsk.test.ts`
- Modify: `apps/worker/src/jobs.ts` (`handleStart`, `handleResume`, `handleProxy`), `apps/worker/src/pipeline/run.ts` (`PipelineDeps` type only), `apps/worker/src/pipeline/proxy.ts` (`ProxyDeps` type only), `apps/worker/src/main.ts`
- Test: `packages/core/src/db/personal.test.ts`, `apps/worker/src/jobs.test.ts`, `apps/web/app/api/misc.test.ts`

**Interfaces:**
- Consumes: `sessions.goal` (Task 2).
- Produces:
  - `type AskEnqueue = (answerId: string) => Promise<void>`; `const ASK_QUEUE_FAILED = "Couldn't start this answer. Please ask again."`; `class AskQueueError extends Error`.
  - `startAskQuestion(db: Db, enqueue: AskEnqueue, a: { sessionId: string; ownerId: string; text: string; onlyIfEmpty?: boolean; onEnqueueError: "rollback" | "fail" }): Promise<{ question: AskMessage; answer: AskMessage } | null>`. It inserts the user question (`done`), then the `pending` answer, in one transaction. With `onlyIfEmpty` the transaction takes `pg_advisory_xact_lock(hashtext(sessionId))` and returns null when the owner already has any `ask_messages` row in the session. Then it calls `enqueue(answer.id)`. If that throws, `"rollback"` deletes both rows and throws `AskQueueError`, and `"fail"` keeps the question and finishes the answer `failed` with `ASK_QUEUE_FAILED`.
  - `startGoalAsk(deps: { db: Db; enqueueAsk?: (messageId: string) => Promise<void> }, sessionId: string): Promise<"started" | "skipped">`. It skips when there is no `enqueueAsk`, the session is missing or not `ready`, or `goal?.trim()` is empty. Otherwise it calls `startAskQuestion` with `{ ownerId: session.ownerId, text: goal, onlyIfEmpty: true, onEnqueueError: "fail" }`.
  - `PipelineDeps.enqueueAsk?` and `ProxyDeps.enqueueAsk?`: `(messageId: string) => Promise<void>`. `main.ts` sends `QUEUES.ask` `{ messageId }` with `{ ...JOB_OPTIONS, singletonKey: messageId }`.

Why the job level: the session becomes `ready` only inside `settlePreview`, which runs from the analyze step and from the preview-copy job. Calling the hook after `handleStart`, `handleResume` and `handleProxy` finish covers every flip without editing a pipeline step (anti-goal), and a pg-boss retry after a crash runs the hook again. The hook is best effort: it runs after the job's own `try/catch`, and any error is logged and never fails the session.

- [ ] **Step 1: Write the failing tests.**

```ts
// personal.test.ts — describe("startAskQuestion")
it("stores the question then a pending answer and enqueues the answer", /* enqueue called once with answer.id; roles user/assistant, statuses done/pending */);
it("rollback: a failed enqueue removes both rows and throws AskQueueError", /* listAskMessages → [] */);
it("fail: a failed enqueue keeps the question and fails the answer with ASK_QUEUE_FAILED", /* answer.status "failed", text ASK_QUEUE_FAILED */);
it("onlyIfEmpty: two calls at once store one pair", async () => {
  const [a, b] = await Promise.all([start(), start()]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  expect(await listAskMessages(db, OWNER_ID, s.id)).toHaveLength(2);
});

// goalAsk.test.ts
it("starts the goal as the first Ask question of a ready session", async () => {
  expect(await startGoalAsk({ db, enqueueAsk }, s.id)).toBe("started");
  const [q, a] = await listAskMessages(db, s.ownerId, s.id);
  expect(q).toMatchObject({ role: "user", text: "3 clips for Instagram", status: "done" });
  expect(enqueueAsk).toHaveBeenCalledExactlyOnceWith(a!.id);
});
it("a second ready, a restart or a re-run never starts it twice", /* call 3× → "started","skipped","skipped"; 2 rows; enqueue once */);
it("no goal or a blank goal: nothing starts", /* goal null and "  " → "skipped", 0 rows, enqueue never called */);
it("startGoalAsk skips a session that isn't ready, and starts once it is", /* awaiting_context → skipped; failed → skipped; setStage ready → started */);
it("a session whose owner already asked something by hand is left alone", /* existing message → skipped */);
it("a failed enqueue leaves the session ready and shows the failed answer", /* enqueueAsk rejects → stage ready, answer failed ASK_QUEUE_FAILED */);

// jobs.test.ts — in d("handleProxy (the preview copy job)")
it("the copy that makes a session with a goal ready starts Ask once", async () => {
  const id = await seed(); await updateSession(db, id, { goal: "The heated exchanges" });
  const enqueueAsk = vi.fn(async () => {});
  await handleProxy({ db, storage, media: fakeMedia(), enqueueAsk }, { sessionId: id }, FIRST);
  await handleProxy({ db, storage, media: fakeMedia(), enqueueAsk }, { sessionId: id }, FIRST);
  expect(enqueueAsk).toHaveBeenCalledTimes(1);
});

// misc.test.ts — describe("Ask"): the existing POST tests stay as they are (202 with question+answer; QUEUES.ask { messageId } with JOB_OPTIONS + singletonKey; failed send → 503 QUEUE_FAILED and no rows)
```

- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @digestor/core test personal`; `docker compose run --rm worker pnpm --filter @digestor/worker test goalAsk jobs` → FAIL.
- [ ] **Step 3: Implement** `startAskQuestion` in core. Then the route: keep its validation and `readySession`, call `startAskQuestion(db, (id) => boss.send(QUEUES.ask, { messageId: id }, { ...JOB_OPTIONS, singletonKey: id }).then(() => {}), { …, onEnqueueError: "rollback" })`, and map `AskQueueError` → 503 `QUEUE_FAILED`. Next `goalAsk.ts`, then the three job handlers (after their `try/catch`: `await startGoalAsk(deps, sessionId).catch((err) => console.error(...))`). Last, `main.ts` wires `deps.enqueueAsk` and passes it into `handleProxy`'s deps.
- [ ] **Step 4: Run to verify they pass**, then `pnpm typecheck && pnpm test && pnpm test:worker`.
- [ ] **Step 5: Commit** (`feat(ask): one start for questions; the upload goal starts Ask when the video is ready`).

---

### Task 5: `list_clips`, `get_clip_context`, "made with Ask"

**Files:**
- Create: `apps/worker/src/agents/askClips.ts` (pure helpers, no import from `ask.ts`), `apps/worker/src/agents/askClips.test.ts`
- Modify: `packages/core/src/db/personal.ts` (`clipsMadeByAsk`), `apps/worker/src/agents/ask.ts` (two tools, `numberedClips`, prompt lines)
- Test: `apps/worker/src/agents/ask.test.ts`, `packages/core/src/db/personal.test.ts`

**Interfaces:**
- Produces:
  - core `clipsMadeByAsk(db: Db, clipIds: string[]): Promise<Set<string>>`: clips whose `create` event's actor is `"ask"`.
  - `askClips.ts`: `DEFAULT_CONTEXT_S = 60`, `MAX_CONTEXT_S = 180`; `contextWindows(clip: Range, durationMs: number, seconds?: number): { seconds: number; before: Range | null; after: Range | null }` (seconds clamped to 1…180, windows clamped to 0…durationMs, null when empty); `clipLine(a: { n: number; clip: Clip; title: string; moment: Pick<Moment, "startMs" | "endMs" | "checks"> | null; tracks: Pick<Track, "language" | "status" | "approvedAt">[]; madeByAsk: boolean }): string`.
  - `ask.ts`: `numberedClips(ctx: AskContext): Promise<{ n: number; clip: Clip }[]>` (`listClips(db, ownerId, sessionId)`, `n = i + 1`). Every clip number Ask shows or records comes from this function.
  - Tool `list_clips` (no args, read-only). One line per clip: `Clip 2 · <id> · [hh:mm:ss–hh:mm:ss] 38 s · 9:16 · subtitles: pt draft, en approved · render: done · checks: 1 open (context) · made with Ask · "<title>"`. The titles block goes through `evidence()`. With no clips it returns "There are no clips yet. Clips are made on the Briefing ("Prepare clips") or with propose_clip and make_clip_package."
  - Tool `get_clip_context({ clipId: uuid, seconds?: number })` (read-only): "Before clip 2 [a–b]:" and "After clip 2 [c–d]:" blocks, each `evidence(renderTranscript(toSentences(sliceWords(...))))` with speaker ids. The before block keeps the sentences nearest the clip when it is cut (it drops from the start), and the after block keeps the earliest. Each block gets half of `MAX_TOOL_OUTPUT`.
  - Prompt lines (in `buildSystem` Rules): "When the user names a clip by number or title, call list_clips first; its numbers are the ones the user sees in Prepare." and "For what comes just before or after a clip (the question before an answer, where an argument continues), call get_clip_context, then trim_clip."

- [ ] **Step 1: Write the failing tests.**

```ts
// askClips.test.ts
it("get_clip_context bounds: 60 s by default, at most 180, never past the video", () => {
  expect(contextWindows({ startMs: 120_000, endMs: 150_000 }, 600_000)).toEqual({ seconds: 60, before: { startMs: 60_000, endMs: 120_000 }, after: { startMs: 150_000, endMs: 210_000 } });
  expect(contextWindows({ startMs: 120_000, endMs: 150_000 }, 600_000, 500).seconds).toBe(180);
  expect(contextWindows({ startMs: 0, endMs: 30_000 }, 600_000).before).toBeNull();
  expect(contextWindows({ startMs: 570_000, endMs: 600_000 }, 600_000).after).toBeNull();
  expect(contextWindows({ startMs: 20_000, endMs: 40_000 }, 50_000, 60)).toMatchObject({ before: { startMs: 0, endMs: 20_000 }, after: { startMs: 40_000, endMs: 50_000 } });
});
it("clipLine says format, languages and their status, render, open checks and made with Ask", /* toContain each part */);

// ask.test.ts — describe("clip tools") with seed/ask/call/toolStep/answer/depsFor
it("list_clips numbering matches Prepare", async () => {
  // three clips created out of time order; Prepare's order is listClips
  const shown = (await listClips(db, OWNER_ID, s.id)).map((c, i) => `Clip ${i + 1} · ${c.id}`);
  for (const line of shown) expect(result).toContain(line);
});
it("list_clips numbers what Prepare shows after a merge and a reorder", /* mergeClips absorbs one, a trim moves one earlier; absorbed clip absent, numbers follow listClips */);
it("list_clips marks clips Ask made and puts titles inside <transcript>", /* propose_clip-made clip → "made with Ask"; title in evidence block */);
it("get_clip_context returns the transcript before and after the clip with speakers", /* contains "Before clip 1", "After clip 1", "A:" or "B:" lines */);
it("get_clip_context on another owner's or a deleted clip is an error to the model", /* "Error: there is no clip" */);

// personal.test.ts
it("clipsMadeByAsk is the clips whose creation was by Ask", /* createClip actor ask vs user */);
```

- [ ] **Step 2: Run to verify they fail.** `docker compose run --rm worker pnpm --filter @digestor/worker test askClips ask.test` → FAIL.
- [ ] **Step 3: Implement** the core helper, `askClips.ts`, then the two tools and the prompt lines in `ask.ts`. The title is the clip's moment title (`getMoment`), or "(no title)". Open checks use core `checksForClip` and `warningsAck`: "checks: running", "checks: ok", "checks: n open (argument / context / quoting someone else / interpreter)", or "checks: made for the original cut".
- [ ] **Step 4: Run to verify they pass**, then `pnpm typecheck && pnpm test:worker`.
- [ ] **Step 5: Commit** (`feat(ask): list_clips and get_clip_context`).

---

### Task 6: Stale approval cards

**Files:**
- Modify: `apps/worker/src/agents/ask.ts` (`trim_clip` records its clip; `AskContext.versions`; `staleText`; `readResolution` keeps `stale`), `apps/worker/src/agents/askGraph.ts` (`approve` copies `clips`; `tools` pre-check), `apps/web/app/api/ask-actions/[id]/route.ts`, `apps/web/components/Ask/ApprovalCard.tsx`, `apps/web/lib/askText.ts` (`parseApprovalPayload` keeps `clips`; `staleLine`), `apps/web/messages/en.ts`
- Test: `apps/worker/src/agents/askGraph.test.ts`, `apps/web/app/api/misc.test.ts`, `apps/web/components/Ask/ApprovalCard.test.tsx`, `apps/web/lib/askText.test.ts`

**Interfaces:**
- Consumes: `CardClip`, `StaleClip`, `staleCardClips`, `updateClip(..., { expectVersion })`, `StaleClipError` (Task 2); `numberedClips` (Task 5).
- Produces:
  - `ToolResult` gains `clips?: CardClip[]`. In plan mode, a tool that changes an existing clip returns `clips: [{ id, n, version: clip.editVersion }]`, and `approve` stores it on the call. Tasks 7–8 do the same.
  - `trim_clip` summary: `Change clip ${n} ${ts(start)}–${ts(end)} to ${ts(newStart)}–${ts(newEnd)}` (update existing assertions on the old "Change the clip …" text).
  - `Approval` (askGraph) gains `clips: CardClip[]` and `stale?: StaleClip[]`, both read from the action's payload and resolution. `AskContext.versions: Map<string, number>` holds the expected version per clip in apply mode. A successful apply stores the clip's new version back into the map, so a second call on the same clip in the same card still passes.
  - `staleText(stale: StaleClip[]): string` → "Clip 2 changed since this card was made (edited by hand or removed). Nothing was changed: tell the user, and offer to ask again." (the model reads this).
  - The `tools` node, when the decision is approve/edit and the card has clips: `staleCardClips` first. If any clip is stale, every asked call gets `{ text: staleText(stale), ok: false }` and none runs. A `StaleClipError` thrown during apply becomes the same text for that call (ToolInputError path).
  - Route: on approve/edit, after the `VIDEO_REMOVED` check, it runs `staleCardClips(db, OWNER_ID, cardClips)`. If any clip is stale, it calls `resolveToolApproval(db, id, { decision: "reject", stale })`, sends `ask.resume` as usual (so the answer ends), and answers 409 with `staleLine(stale)`.
  - `staleLine(stale)` (web, `askText.ts`): first stale clip → `t("ask.approval.stale", { n })` "Clip {n} changed since this card was made. Ask again." or `t("ask.approval.staleRemoved", { n })` "Clip {n} was removed since this card was made. Ask again.". `ApprovalCard`'s decided state shows `staleLine` instead of "Declined." when `resolution.stale` is set.

- [ ] **Step 1: Write the failing tests.**

```ts
// askGraph.test.ts — describe("stale approval cards")
it("the card records the clip's number and edit version", /* payload.calls[0].clips → [{ id, n: 2, version: 0 }] */);
it("stale-card refusal: a clip trimmed by hand after the card was made is not changed on approve", async () => {
  // pause on trim_clip for clip 2; updateClip(db, clip2, {startMs,endMs}, "user"); approve + resumeAsk
  expect(await getClip(db, clip2.id)).toMatchObject(manual);              // manual bounds kept
  expect(toolResults(llm.calls.at(-1)!)[0]).toContain("Clip 2 changed since this card was made");
});
it("a card with two calls applies neither when one clip went stale", /* trim clip 1 + trim clip 2; manual edit on clip 2; clip 1 unchanged too */);
it("a manual trim after the route's check is still refused at apply time", /* resolveToolApproval approve, THEN manual updateClip, THEN resumeAsk → unchanged */);
it("a clip removed while the card waits is refused as removed", /* deleteClip → text names "removed" */);

// misc.test.ts — describe("POST /api/ask-actions/[id] (tool_approval)")
it("Approve on a stale card answers 409 with the stale sentence, stores the stale resolution and resumes", async () => {
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("Clip 2 changed since this card was made. Ask again.");
  expect(await getAskAction(db, actionId)).toMatchObject({ status: "dismissed", resolution: { decision: "reject", stale: [{ n: 2, removed: false }] } });
  expect(h.send).toHaveBeenCalledWith(QUEUES.askResume, { actionId }, expect.objectContaining({ singletonKey: actionId }));
});
it("Reject on a stale card is an ordinary reject (200)", /* no stale check on reject */);

// ApprovalCard.test.tsx
it("a stale card says which clip changed instead of Declined", /* action status dismissed, resolution.stale → text, no buttons */);
```

- [ ] **Step 2: Run to verify they fail.** `docker compose run --rm worker pnpm --filter @digestor/worker test askGraph`; `pnpm --filter @digestor/web test misc ApprovalCard askText` → FAIL.
- [ ] **Step 3: Implement** in the order of the Interfaces block. In `trim_clip` apply, pass `{ expectVersion: ctx.versions.get(clip.id) }` to `updateClip`. Catch `StaleClipError` in `runTool`'s ToolInputError branch (convert it in the tool).
- [ ] **Step 4: Run to verify they pass**, then `pnpm typecheck && pnpm test && pnpm test:worker`.
- [ ] **Step 5: Commit** (`feat(ask): approval cards refuse changes to clips edited since`).

---

### Task 7: `update_clip`

**Files:**
- Modify: `packages/core/src/db/personal.ts` (`applyClipUpdate`, `undoLastEvent` for `update`), `apps/worker/src/agents/ask.ts` (tool, `MUTATING_TOOLS`, prompt line), `apps/web/lib/prepareData.ts` (`undoStep`), `apps/web/messages/en.ts` (`prepare.undoAsk` "Undo Ask's change")
- Test: `packages/core/src/db/personal.test.ts`, `apps/worker/src/agents/askGraph.test.ts`, `apps/web/lib/prepareData.test.ts`

**Interfaces:**
- Consumes: Task 2's version helpers, Task 5's `numberedClips`, Task 6's `clips`/`versions`.
- Produces:
  - `applyClipUpdate(db: Db, a: { clipId: string; ownerId: string; format?: ClipFormat; credit?: string | null; title?: string; addLanguage?: string; actor: ClipActor; expectVersion?: number }): Promise<{ clip: Clip; trackId: string | null }>`. It is one transaction. A format change sets `cropOffset: 0` (centre). A credit change sets `creditSetAt`. A title change renames the clip's moment only when that moment is this owner's own (`moments.ownerId === ownerId`); otherwise it throws `ClipTitleNotOwnError`. A new language inserts a `preparing` track. The version is bumped once. Finished renders and burns are staled as `updateClip` does. It writes **one** event `kind: "update"`, `before: { format, cropOffset, credit, creditSetAt, title?: { momentId, title } }`, `after: { …, addedTrackId }`.
  - `undoLastEvent` on `update`: restores format, crop and credit, renames the moment back, deletes the added track unless it has been approved or a burn is queued or rendering, stales renders, and bumps the version.
  - Tool `update_clip({ clipId: uuid, format?: "16:9" | "9:16", title?: string, credit?: string, addSubtitles?: string })`. It is mutating, `requireVideo`, `requireDirectChange`, and needs at least one field. The language is checked with `subtitleLanguageOk`, and a language the clip already has is an error. Plan summary: `Change clip ${n}: format 9:16 (crop back to the centre), credit "…", title '…', add Portuguese subtitle draft`. Apply: `applyClipUpdate`, then claim and send `track.prepare` for the new track (on a failed send, `deleteTrack` and say so, as `make_clip_package` does). Record `clipId`. It cannot burn in, approve subtitles or export.
  - The title restriction is a resolved spec/code gap: clips have no title column, so a clip's title is its moment's. An analysis moment's title is the official analysis, which Ask never changes. The model reads: "Clip 2's title comes from the analysis and can't be changed; only clips you or Ask made can be renamed."
  - Prompt line: "update_clip changes a clip's format, title, credit line or adds a subtitle draft; X and YouTube mean 16:9, Instagram, TikTok, Reels and Shorts 9:16."
  - Web `UndoStep` gains `{ kind: "ask" }`, and `undoStep` maps `update` and `replace` events to it (label `prepare.undoAsk`).

- [ ] **Step 1: Write the failing tests.**

```ts
// personal.test.ts — describe("applyClipUpdate")
it("changes format (crop to centre), credit and adds a language in one event and one version", async () => {
  const { clip, trackId } = await applyClipUpdate(db, { clipId, ownerId: OWNER_ID, format: "16:9", credit: "TV Globo", addLanguage: "pt", actor: "ask" });
  expect(clip).toMatchObject({ format: "16:9", cropOffset: 0, credit: "TV Globo", editVersion: v0 + 1 });
  expect((await listClipEvents(db, clipId)).filter((e) => e.kind === "update")).toHaveLength(1);
  expect((await getTrack(db, trackId!))!.status).toBe("preparing");
});
it("renames a personal moment, refuses an analysis moment's title", /* ClipTitleNotOwnError */);
it("undo of an update restores everything it set and removes its unapproved track", /* format, cropOffset, credit, title back; track gone */);
// askGraph.test.ts — describe("update_clip")
it("update_clip plan and apply: the card names clip 3, approve makes it 16:9 with a Portuguese draft", async () => {
  // list_clips, then update_clip {clipId: clip3, format: "16:9", addSubtitles: "pt"}; pause
  expect(card.calls[0]).toMatchObject({ name: "update_clip", summary: expect.stringContaining("Change clip 3"), clips: [{ n: 3 }] });
  expect(await getClip(db, clip3.id)).toMatchObject({ format: "9:16" });            // nothing before approval
  // approve + resume
  expect(await getClip(db, clip3.id)).toMatchObject({ format: "16:9", cropOffset: 0 });
  expect(deps.send).toHaveBeenCalledWith(QUEUES.prepareTrack, { trackId: expect.any(String) }, expect.any(String));
});
it("update_clip counts as one change toward the cap of 3", /* 3 trims approved, then update_clip refused with CONFIRM_FIRST */);
it("two calls on the same clip in one card both apply (the second expects the first's new version)", /* trim_clip + update_clip on clip 1 in one turn → both applied, not stale */);
it("update_clip without any field, or with a language the clip has, is an error to the model and asks nothing", /* no tool_approval row */);
// prepareData.test.ts
it("Prepare's undo labels an Ask update or replace as Ask's change", () => expect(undoStep([{ kind: "update", undoneAt: null }])).toEqual({ kind: "ask" }));
```

- [ ] **Step 2: Run to verify they fail** (core, worker, web focused runs as above) → FAIL.
- [ ] **Step 3: Implement** in the order of the Interfaces block. Add `update_clip` to the "change the user's own clips" rule line in `buildSystem`.
- [ ] **Step 4: Run to verify they pass**, then all suites and `pnpm typecheck`.
- [ ] **Step 5: Commit** (`feat(ask): update_clip`).

---

### Task 8: `replace_clip` with an exact Undo

**Files:**
- Modify: `packages/core/src/db/personal.ts` (`replaceClipMoment`, `undoLastEvent` for `replace`), `apps/worker/src/agents/ask.ts` (tool, `MUTATING_TOOLS`, prompt lines), `apps/web/lib/askEdits.ts` (`replace_clip: () => ClipEdit`), `apps/web/components/Ask/ApprovalCard.tsx` (`isClip` includes `replace_clip`)
- Test: `packages/core/src/db/personal.test.ts`, `apps/worker/src/agents/askGraph.test.ts`, `apps/web/lib/askEdits.test.ts`, `apps/web/app/api/personal.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 6, 7.
- Produces:
  - `replaceClipMoment(db: Db, a: { clipId: string; ownerId: string; analysisId: string; startMs: number; endMs: number; title: string; actor: ClipActor; expectVersion?: number }): Promise<{ clip: Clip; momentId: string; trackIds: string[] }>`. It runs in one transaction under `pg_advisory_xact_lock(hashtext(sessionId))`. It inserts a personal moment (origin `"ask"`, approved), points the clip at it with the new bounds, and sets `warningsAck` and `protectedAck` to false. It keeps the clip's id (its place in the list), format, crop, credit, style and languages. It deletes the clip's tracks and inserts one `preparing` track per language, then bumps the version and stales a finished render. It writes one `replace` event whose `before` is `{ startMs, endMs, momentId, warningsAck, protectedAck, oldSelection, tracks: <full rows> }` and whose `after` is `{ startMs, endMs, momentId }`.
  - The old moment's approval is cleared (undecided), so a later "Prepare clips" can't bring the replaced clip back as a fourth clip. This is a resolved spec gap, named on the card: "…; its moment goes back to undecided on the Briefing". Undo restores the approval.
  - `undoLastEvent` on `replace` restores the clip's bounds, moment and acknowledgements, re-inserts the snapshot tracks (cues, approval and built range as they were; a burn that was `done` comes back `stale`), deletes the replacement tracks, restores the old selection and removes the new moment's approval, stales the render and bumps the version. The new personal moment row stays, undecided.
  - Tool `replace_clip({ clipId: uuid, start, end, title })`. It is mutating and counts as one change. It goes through `requireAnalysis`, `requireVideo`, `snapClip` (a full snap, not `snapEdges`) and `requireDirectChange`. Plan summary: `Replace clip ${n} (${old range} '${old title}') with ${new range} '${title}'; its moment goes back to undecided on the Briefing`, plus `range` (for Edit) and `clips`. Apply: `replaceClipMoment`, then `requestMomentCheck(newMoment)` and claim-then-send `track.prepare` per new track (a failed send marks that track failed with `failTrack`, so Prepare offers "Try again"). Record `clipId`. No render is started.
  - Prompt lines: "When the user wants a different moment instead of an existing clip ("instead of clip 2"), find candidates with list_moments or search_transcript, pick by the moment's highlight type and reason (a calmer moment is not one marked Heated), and use replace_clip, never propose_clip: the user keeps the same number of clips."

- [ ] **Step 1: Write the failing tests.**

```ts
// personal.test.ts — describe("replaceClipMoment")
it("keeps the clip's id, place, format, crop, credit and languages; new moment, bounds, reset acknowledgements", /* … */);
it("Undo restores the old clip exactly", async () => {
  const before = { clip: await getClip(db, id), tracks: await listTracks(db, id), selections: await listSelections(db, OWNER_ID, s.id) };
  await replaceClipMoment(db, { …, actor: "ask" }); await undoLastEvent(db, id);
  expect(await getClip(db, id)).toMatchObject(pick(before.clip!, ["startMs", "endMs", "momentId", "warningsAck", "protectedAck", "format", "cropOffset", "credit"]));
  expect((await listTracks(db, id)).map(pick(["language", "cues", "approvedAt", "builtStartMs", "builtEndMs", "status"]))).toEqual(before.tracks.map(/* same */));
  expect(await listSelections(db, OWNER_ID, s.id)).toMatchObject({ [oldMomentId]: "approved" });
});
it("after a replace, Prepare clips (confirmClips) doesn't bring the old moment's clip back", /* still 3 clips */);
// askGraph.test.ts — describe("replace_clip")
it("instead of clip 2: replace_clip keeps three clips, and the card names clip 2", /* listClips length 3 before and after; clip 2 id unchanged; new bounds; checks requested for the new moment (send moment.check) */);
it("the card's Edit changes the new times and title", /* decision edit → edited range snapped */);
// personal.test.ts (web, /api/clips/[id]/undo)
it("the Ask chip's undo (ifActor ask) reverts a replace", /* 200, old bounds back */);
it("the Ask chip's undo leaves a later manual edit alone", /* replace, then PATCH trim by user → undo ifActor ask → 409 "There is nothing to undo."; manual bounds kept */);
// askEdits.test.ts
it("replace_clip edits take start, end and title like propose_clip", /* readEdits accepts; extra keys rejected */);
```

- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement** in the order of the Interfaces block (core first, then the tool, then the web edit schema and card).
- [ ] **Step 4: Run to verify they pass**, then all suites and `pnpm typecheck`.
- [ ] **Step 5: Commit** (`feat(ask): replace_clip, undone exactly`).

---

### Task 9: `ask_user` (worker) and AskThread split (web)

**Files:**
- Modify: `apps/worker/src/agents/ask.ts` (tool spec, prompt rule), `apps/worker/src/agents/askGraph.ts` (terminal in `agent`), `apps/worker/scripts/eval-ask.ts` (count clarifying questions)
- Create: `apps/web/components/Ask/AskThread.tsx`, `apps/web/components/Ask/AskThread.test.tsx`, `apps/web/lib/useDesktop.ts`
- Modify: `apps/web/components/Ask/AskDrawer.tsx` (frame only), `apps/web/lib/askText.ts`, `apps/web/messages/en.ts`
- Test: `apps/worker/src/agents/askGraph.test.ts`, `apps/web/lib/askText.test.ts`

**Interfaces:**
- Produces (worker):
  - Tool spec `ask_user({ question: string (1–300), options: string[] (2–4, each 1–60) })`. When it is the **only** call of a turn and parses, the `agent` node ends the answer: `final = question`, `settled: true` (never verified), and it appends the record `{ name: "ask_user", args: { question, options }, result: question.slice(0, 300), ok: true }`. Called with other tools, its `run` returns "Error: ask_user ends your answer: call it alone." The options live in `ask_messages.tool_calls`, so no column is added.
  - Prompt rule: "If a missing answer would change the result (platform or format, number of clips, subtitle language, which person or topic when it is ambiguous), call ask_user alone with one short question and 2–4 short options, before any other tool. Ask at most one question per request, and never ask what the request or the transcript already answers."
  - `eval-ask.ts` prints "Asked a clarifying question: n of N" (answers whose records include `ask_user`).
- Produces (web):
  - `askUserPrompt(calls: AskToolCallRecord[]): { question: string; options: string[] } | null`; `sourceLines` returns `[]` for `ask_user`; `clipLinks(call: AskToolCallRecord): { clipId: string; title: string | null }[]` (`clipId` or `clipIds`, titles from `args.title` or `args.clips[i].title`).
  - `AskThreadMessage`: today's `Message` type of `AskDrawer.tsx`, moved and exported.
  - `AskThread(props: AskThreadProps)`: `{ sessionId: string; language: string | null; hasVideo: boolean; videoRemoved: boolean; examples: string[]; active: boolean; initialMessages?: AskThreadMessage[]; inputRef?: React.Ref<HTMLTextAreaElement> }`. It holds what is today inside `DialogContent` below the title (preview player, messages, cards, undo, polling while `active`, the input). Options render as buttons (`aria-label` group `t("ask.quickReplies")` "Quick answers") only on the **last** message when it is `done` and nothing is sending. A click sends that option as the next question. Change chips get links `t("ask.openInPrepare")` "Open in Prepare" or `t("ask.openClipInPrepare", { title })` to `/s/<id>/prepare#clip-<clipId>`.
  - `AskDrawer` keeps the trigger button, `/`, the `Dialog` frame, title and description, and renders `<AskThread active={open} …/>`. It becomes controlled: props `open: boolean; onOpenChange(next: boolean): void` in addition to today's.
  - `useDesktop(): boolean` moved out of `AskDrawer` unchanged.

- [ ] **Step 1: Write the failing tests.**

```ts
// askGraph.test.ts — describe("ask_user")
it("ask_user stored: one call ends the answer with the question and its options, unverified", async () => {
  // llm: toolStep(call("ask_user", { question: "Which platform?", options: ["Instagram / TikTok (9:16)", "X / YouTube (16:9)"] }))
  expect(msg).toMatchObject({ status: "done", text: "Which platform?" });
  expect(asToolCalls(msg.toolCalls).find((c) => c.name === "ask_user")?.args).toEqual({ question: "Which platform?", options: [...] });
  expect(llm.calls).toHaveLength(1);                       // no verify, no further turn
});
it("ask_user with another tool in the same turn is an error to the model", /* tool result "ask_user ends your answer" */);
it("ask_user with one option or five is invalid arguments", /* "Error: invalid arguments for ask_user" */);
// askText.test.ts
it("askUserPrompt reads the question and options; sourceLines ignores ask_user", /* … */);
it("clipLinks gives one link per clip, titled for a package", /* … */);
// AskThread.test.tsx (vi.mock("next/navigation"); renderToStaticMarkup)
it("ask_user rendered as options: the last answer's options are buttons", () => {
  const html = render([userQ, askUserAnswer]);
  expect(buttons(html)).toEqual(expect.arrayContaining(["Instagram / TikTok (9:16)", "X / YouTube (16:9)"]));
});
it("only the last answer's options are buttons", /* earlier ask_user answer followed by another Q/A → its options not buttons */);
it("a clip change links to its card in Prepare", /* href="/s/s1/prepare#clip-<id>" */);
it("AskThread renders in the drawer: the input, the examples on an empty thread", /* "ask-input", examples */);
```

- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement** the worker part, then move the conversation out of `AskDrawer` into `AskThread` without changing its behaviour (same polling, `router.refresh()` when an answer stops, undo, decide). Then add options and links.
- [ ] **Step 4: Run to verify they pass**; existing `ApprovalCard.test.tsx` and `askText.test.ts` stay green; then all suites and `pnpm typecheck`.
- [ ] **Step 5: Commit** (`feat(ask): ask_user quick replies; AskThread split from the drawer`).

---

### Task 10: Ask first: docked by default with a goal, phone banner, Ask on Prepare, "Made with Ask"

**Files:**
- Create: `apps/web/lib/askDock.ts`, `apps/web/lib/askDock.test.ts`, `apps/web/components/Ask/useAskDock.ts`, `apps/web/components/Ask/AskDraftBanner.tsx`
- Modify: `apps/web/lib/briefingPage.ts` (`session.goal`, `askStarted`), `apps/web/components/Briefing/Briefing.tsx`, `apps/web/app/s/[id]/prepare/page.tsx`, `apps/web/components/Prepare/PrepareList.tsx`, `apps/web/components/Prepare/ClipIndex.tsx`, `apps/web/messages/en.ts`
- Test: `apps/web/components/Prepare/ClipIndex.test.tsx` (new), `apps/web/components/Prepare/PrepareList.test.tsx` (new, static render with `vi.mock("next/navigation")`)

**Interfaces:**
- Consumes: `AskDrawer` (controlled), `AskThread`, `useDesktop` (Task 9); `clipsMadeByAsk` (Task 5); `sessions.goal`.
- Produces:
  - `askDock.ts` (client-safe, same storage pattern as `bannerDismiss.ts`): `askDockKey(sessionId) = "digestor:ask:<id>"`; `readAskDock(storage, sessionId): "open" | "closed" | null`; `writeAskDock(storage, sessionId, state: "open" | "closed"): boolean`; `initialAskOpen(a: { desktop: boolean; hasGoal: boolean; remembered: "open" | "closed" | null }): boolean` (true only when `desktop && hasGoal && remembered !== "closed"`); `showDraftBanner(a: { desktop: boolean; hasGoal: boolean; askStarted: boolean; remembered: "open" | "closed" | null; open: boolean }): boolean` (true only when `!desktop && hasGoal && askStarted && remembered !== "closed" && !open`).
  - `useAskDock(sessionId: string, hasGoal: boolean): { open: boolean; setOpen(next: boolean): void; desktop: boolean; remembered: "open" | "closed" | null }`. It starts closed (the server render is closed too), applies `initialAskOpen` once after mount, and writes the user's open or close to storage.
  - `BriefingProps.session.goal: string | null`, `BriefingProps.askStarted: boolean` (the owner has any Ask message in the session). `PrepareListProps.session.goal: string | null`.
  - `AskDraftBanner({ onOpen })`, at the top of the Briefing, phone only: `t("ask.draftBanner")` "Ask has a draft for you" and a button `t("ask.draftOpen")` "Open". It never opens the sheet by itself.
  - Prepare: `PrepareList` renders `AskDrawer` in its header, beside the title row, with `examples` from `t("ask.prepareExamples.shorter")` "Make clip 1 shorter", `…question` "Include the question before clip 1", `…platform` "Make clip 1 for Instagram with English subtitles". `/` opens it there too. The `router.refresh()` that `AskThread` already does lands in `PrepareList`'s `merge`, so a replace, an update or a new clip shows without a reload.
  - `PrepareClipData.madeByAsk: boolean` and `ClipIndexEntry.madeByAsk: boolean`. `ClipIndex` and the clip card header show a small tag `t("prepare.madeWithAsk")` "Made with Ask" (text, not colour only).

- [ ] **Step 1: Write the failing tests.**

```ts
// askDock.test.ts
it("docks by default on desktop only when the session has a goal and the user hasn't closed it", () => {
  expect(initialAskOpen({ desktop: true, hasGoal: true, remembered: null })).toBe(true);
  expect(initialAskOpen({ desktop: true, hasGoal: false, remembered: "open" })).toBe(false);   // the goal rule wins
  expect(initialAskOpen({ desktop: true, hasGoal: true, remembered: "closed" })).toBe(false);
  expect(initialAskOpen({ desktop: false, hasGoal: true, remembered: null })).toBe(false);     // never a sheet on arrival
});
it("the phone banner shows only with a goal whose Ask started, until closed once", /* showDraftBanner cases */);
it("storage that throws reads as null and writes return false", /* fake storage throwing */);
// ClipIndex.test.tsx
it("tags clips made with Ask", /* entry madeByAsk → "Made with Ask"; other entry without */);
// PrepareList.test.tsx
it("AskThread renders on Prepare: the Ask button with its / shortcut is in the header", /* aria-keyshortcuts="/" and "Ask" */);
```

- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement.** `briefingPage.ts` and the Prepare page read `session.goal`. The Briefing page counts the owner's Ask messages with `listAskMessages(...).length > 0`, and the Prepare page reads `clipsMadeByAsk(db, clips.map((c) => c.id))`. `Briefing` and `PrepareList` call `useAskDock` and pass `open`/`onOpenChange` to `AskDrawer`. `Briefing` renders `AskDraftBanner` when `showDraftBanner(...)` is true. Check that the docked panel keeps today's 28 rem body padding on both pages, and that nothing in the stepper, filters, Approve / Skip or "Prepare clips" moves when Ask is closed.
- [ ] **Step 4: Run to verify they pass**, then `pnpm typecheck && pnpm test`. With the `digestor-run` skill, screenshot the Briefing and Prepare at 1280 px (goal session: docked; no-goal session: closed) and at 375 px (banner, no sheet), and check the console for errors.
- [ ] **Step 5: Commit** (`feat(web): Ask docked first with a goal, phone banner, Ask on Prepare, Made with Ask tag`).

---

### Task 11: README, CLAUDE.md and deploy notes

**Files:**
- Modify: `README.md` ("How it works": flowchart and items 1, 5, 6, 9; Ask section; "Where the AI tooling lives"; prompt-injection paragraph naming the six mutating tools), `CLAUDE.md` (Stages/Ask bullet: the goal and `startGoalAsk`, new tools, `ask_user`, edit version and stale cards, clip event kinds `update`/`replace`; "Conventions that bite": the cap sentence counts `update_clip` and `replace_clip`), `docs/deploy.md` (a section "Once, when updating to AI goes first (migration 0036)": nothing to run by hand; migration adds two columns; no new env vars, no new queue)

- [ ] **Step 1:** Update the README: the flowchart gets an optional "Goal" input at upload and an "Ask starts on the goal" edge at Briefing. Item 1 mentions the goal field. Item 9 describes Ask docked first with a goal, on Prepare too, the new tools in one line each, quick-reply questions, stale cards and "Made with Ask". Every claim must match the code (grep each named function or constant).
- [ ] **Step 2:** Update CLAUDE.md and `docs/deploy.md` as listed. Do not change the "Workflow" section.
- [ ] **Step 3:** Ask a fresh reviewer (subagent) to check every new README and CLAUDE.md claim against the code, then fix what it finds.
- [ ] **Step 4: Commit** (`docs: AI goes first in README, CLAUDE.md and the deploy runbook`).

---

### Task 12: Full test suites

- [ ] **Step 1:** `pnpm typecheck` → no errors.
- [ ] **Step 2:** `pnpm test` (core + web, host) → all pass.
- [ ] **Step 3:** `pnpm test:worker` (in the container) → all pass.
- [ ] **Step 4:** `pnpm --filter @digestor/web lint` → no errors in changed files. Fix and commit anything found (`fix: …`).

---

### Task 13: Ask evaluation rerun

- [ ] **Step 1: Retrieval (free).**

```bash
docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval-ask.ts eval/ask/globo-debate.ask.json
docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval-ask.ts eval/ask/osang-merkel.ask.json
```

Expected: identical to `docs/capstone/evaluation.md` (recall@6 0.80 / 0.70, MRR 0.75 / 0.70), since retrieval code did not change.

- [ ] **Step 2: Answers (paid, about $0.04 per file).** Run the same two commands with `--answers`.
- [ ] **Step 3: Judge "within the known noise".** The run passes when:
  - every rate is inside the range of the 13 Nov and 16 Nov "after" runs, widened by one question (±10 points). Debate citation hit 70–100%, interview 70–100%; quote exact debate ≥ 90%, interview ≥ 53%.
  - refusal correct is 50% or 100% (2 questions).
  - "gave up on the step limit" is at most 3 of 12 for the debate and 2 of 12 for the interview.
  - "Asked a clarifying question" is **0 of 12** for both. These are factual questions; any `ask_user` here means the prompt rule over-fires, which is a failure to fix, not noise.

  Outside those bounds: read the differing answers, decide whether the new prompt lines caused it, fix and rerun once.
- [ ] **Step 4:** Add a dated "Re-run, 21/22 November 2026 (AI goes first)" paragraph to `docs/capstone/evaluation.md` with the numbers, cost and the clarifying-question count. Commit (`docs(eval): Ask rerun after AI goes first`).

---

### Task 14: Local end-to-end check of every "Done when"

Use the `digestor-run` skill (stack up, `pnpm db:migrate`, web dev server, Playwright). Record a status table (item, result, evidence path) and give it to the owner.

- [ ] **Step 1 (Done when 1).** Upload the Globo debate again as a **new** session. Use the file from the owner session's `data/7433d1c6…/original.*` if it still exists, else that session's YouTube `source_url`. Never touch the owner session itself. Type at upload: "Create three short clips about education, with English subtitles, for social media". Tell the owner the cost the confirm dialog shows before confirming. Answer the context check. Without any other click, check that the desktop Briefing opens with Ask docked, that the first answer is one clarifying question with option buttons, and, after clicking an option, that a package card with candidates appears. Approve it and see the clips in the Briefing (personal markers), Prepare (tagged "Made with Ask") and Export.
- [ ] **Step 2 (Done when 2).** In Ask on that session, run each request, check its card, approve it, and confirm the result in Prepare:
  - "include the question before clip 1": `get_clip_context` then `trim_clip`, clip 1 starts earlier, on a sentence edge.
  - "make clip 2 shorter": `trim_clip`, clip 2 shorter.
  - "make clip 3 for X with Portuguese subtitles": `update_clip`, clip 3 is 16:9 with a Portuguese draft.
  - "choose a less confrontational moment instead of clip 2": `replace_clip`, still 3 clips. The chip's Undo brings the old clip 2 back (bounds, title, subtitles).
- [ ] **Step 3 (Done when 3).** Ask "make clip 2 shorter" and leave the card pending. Trim clip 2 by hand in Prepare. Approve: the card says "Clip 2 changed since this card was made. Ask again." and clip 2 keeps the manual trim.
- [ ] **Step 4 (Done when 4).** On a seeded session with no goal (`seed-demo.ts --stage ready`): no Ask message exists, Ask is closed on Briefing and Prepare, `/` still opens it, and the stepper, filters, Approve / Skip, "Prepare clips", Prepare and Export behave as on `main`.
- [ ] **Step 5 (phone).** At 375 px on the goal session: no sheet covers the page on arrival; the banner "Ask has a draft for you" + Open opens it.
- [ ] **Step 6 (Done when 5–6).** Tasks 12 and 13 passed, and Task 11 is committed. Record the "after" video (same path and length as Task 1, saved as `reports/ai-goes-first/after.webm`) of Done when 1 and the replace + Undo. Tell the owner both files are ready for the portfolio.
- [ ] **Step 7:** Delete the test session and its Chroma collection only if the owner says so (it cost money to make); otherwise list it in the status table as a test session.

---

### Task 15: Stop before production

- [ ] **Step 1:** Post the final status table (tasks, test results, eval numbers, Done-when evidence, the test session id) and the branch's commit list (`git log --oneline main..ai-goes-first`).
- [ ] **Step 2: Stop.** Do not merge, push or deploy. Deploy only after the owner's explicit permission in chat, following `docs/deploy.md` ("Updating", then the new "AI goes first (migration 0036)" section). If sign-in has merged first, rebase and renumber the migration (Global Constraints) before asking.
