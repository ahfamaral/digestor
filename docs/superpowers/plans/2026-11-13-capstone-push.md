# Capstone push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Digestor for the Turing College capstone review: the written deliverables (ethics, showcase, presentation outline, user test, "why not LangGraph" PDF), measured RAG quality, an Ask that runs on LangGraph with approval before changes and a verify-before-answering loop, clip packages, Ask across videos, and four monitor additions (search by meaning, clip this speech, Ask the record, word heat map).

**Architecture:** Branch `capstone-push` from `main` 4e86ff3, never merged, pushed or deployed without the owner's word. Ask keeps its tools and rules (R31 cap, `evidence()`, `ask_actions`) but its loop becomes a LangGraph `StateGraph` with a Postgres checkpointer; a pause is an `ask_actions` row the drawer already knows how to show. The monitor's meaning search lives in the worker (it already has the e5 model and Chroma) behind a small internal HTTP endpoint; the web app fuses it with the existing `tsvector` search. The heat map is plain SQL counting on Postgres's Portuguese stemmer plus weighted log-odds in a pure function.

**Tech Stack:** TypeScript (strict, ESM), pnpm monorepo, Next.js 16, Drizzle + Postgres, pg-boss 12, Chroma + `Xenova/multilingual-e5-small`, LangChain (`@langchain/core`, `/anthropic`, `/openai`), `@langchain/langgraph` 1.7.x + `@langchain/langgraph-checkpoint-postgres` 1.1.x, vitest, Playwright (digestor-run skill), headless Chrome for the PDF.

**Spec:** `.superpowers/sdd/2026-11-13-capstone-push/brief.md` (git-ignored; agreed with the owner 2026-11-13). Read it and `CLAUDE.md` before any task. Own calls go in `.superpowers/sdd/2026-11-13-capstone-push/decisions.md`.

## Global Constraints

- Paid API spend (OpenRouter + AssemblyAI) for the whole run ≤ **US$3**; check `LLM_PROVIDER`/keys in `.env`, log every paid run's cost in the decisions file, stop and ask when the total passes US$2.50.
- Never merge to `main`, push, or touch production. Commits on `capstone-push` only, explicit paths (`git add <file>`, never a directory, never `.env`, `data/`, `apps/worker/eval/results/`, `.DS_Store`, the untracked openrouter fixture).
- Commit messages end with the two attribution lines (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SMwZuLWPpidwn6KbKSnZ7K`).
- Never install or call ffmpeg/yt-dlp on the host; worker tests run in the container (`pnpm test:worker` or the focused form in CLAUDE.md).
- Monitor rule: **no AI-written text about a person**; AI only finds, ranks or labels official text; no rankings between deputies, no scores shown, never "absent". Monitor copy only in `apps/web/messages/monitor.ts` (`tm()`, `en` and `pt-BR`).
- Journalist-flow copy follows the digestor-ui skill (friendly sentences, no "→" glyph, confirm dialogs on one-click data changes, media pauses and stays paused).
- Skills to read before the matching work: `digestor-ui` (any screen), `nextjs16-gotchas` (pages/routes/config), `pgboss-gotchas` (queues, jobs, pauses, resume), `llm-structured-output` (any structured LLM call), `vendor-contract-check` (any fake for Claude/AssemblyAI/yt-dlp), `digestor-run` (seeing a screen).
- Migrations: next numbers are `0026`, `0027`, … (`packages/core/drizzle/`), generated with the repo's drizzle setup; one migration per task that needs one.
- Seeded/test sessions and Chroma collections a task creates are deleted at the task's end; the owner's four real sessions (`7433d1c6…` Globo debate, `f2fce3ea…` Senado, `b3e26a69…` Bundestag, `a8037dcf…` US House) are never deleted or re-analysed.
- Docs for the capstone go in `docs/capstone/` (committed); the LangGraph PDF in root `reports/` (git-ignored; HTML source in `reports/src/`).
- Every task ends green: `pnpm typecheck`, `pnpm test`, and `pnpm test:worker` when worker code changed.

## Review Focus

1. **An Ask paused for approval that never gets an answer** (drawer closed, session expired, video removed): the message stays `waiting` without a job, the drawer shows the card again when reopened, retention removes its checkpoint with the session's index, and Approve on a session whose video was removed answers the friendly `VIDEO_REMOVED` message instead of a 500. Test owned by Task C1.
2. **The same approval clicked twice / two tabs** (double POST, or Approve in one tab and Reject in another): exactly one resume job runs; the second click gets 409 "This suggestion was already handled." Test owned by Task C1.
3. **A verify loop that never converges or a model that quotes a translation** (German interview quoted in English): verification gives up after 2 retries with "I couldn't confirm: …", never loops, and a translated quote is checked as a claim, not failed as a wrong quote. Test owned by Task C2.
4. **Monitor search when the worker endpoint is down or the index is empty** (prod before the first embed run, worker restarting): the topic search answers with word results only, plus a quiet note, never a 500 or an empty page. Test owned by Task D1.
5. **A deputy with almost no speech text, or a party with one deputy** in the word heat map: below the minimum, the section says there isn't enough text yet instead of showing noisy words. Test owned by Task D5.

---

## Phase 0: Kick-off (done by the controller, not a subagent)

- [ ] Branch `capstone-push` exists from 4e86ff3; status file and decisions file exist in the run folder; the 20-minute status cron runs.
- [ ] Start B2's long-running part early (Task B2 step 1, the Osang download and transcription), since it needs ~30 min of wall time and B1 uses its transcript.

---

### Task A3+A4: README ethics section and tidy-up

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** At the top, under the title, add a "Showcase" line with a placeholder link (`<!-- TODO(owner): showcase link before booking the review -->` plus visible text "Showcase video: coming before the review"). Move the existing "Showcase … TODO" section's content there.
- [ ] **Step 2:** Fix every "480p" that describes the preview copy to "360p" (the code makes 360p: `proxy.mp4`, CLAUDE.md).
- [ ] **Step 3:** Add a short "Câmara monitor (extension)" section after the main product sections: what it is, that it is the "what's next", and that it uses no AI text about a person.
- [ ] **Step 4:** Add "## Ethical considerations" with one subsection per point of the brief's A3 (decontextualised quotes, copyright/quotation right with §51 UrhG and Lei 9.610 art. 46 plus the clip credit field, data processors with GDPR/LGPD and the 14-day retention, speaker misattribution, selection bias, prompt injection, the monitor rules). Each subsection: the risk in one sentence, what the code does about it (name the mechanism: sentence snapping, mid-sentence warning, checks, traps in eval, approval before export, `evidence()`, ≤3 direct changes, confirmed names only on trials…), and what remains open. Facts must match CLAUDE.md; anything not built is written as "not built yet".
- [ ] **Step 5:** Ask a fresh reviewer to check every claim against CLAUDE.md and the code (grep the named mechanisms). Commit `docs(readme): ethics section, showcase placeholder, monitor as extension, 360p`.

### Task A2: Showcase text and screenshot list

**Files:** Create `docs/capstone/showcase.md`

- [ ] **Step 1:** Write a ≤ 150-word showcase description (problem, who it's for, what it does, the stack in one line), a 60–90 s video script (shots in order with what the narrator says), and a screenshot list (screen, route, state to seed via the digestor-run skill, what it should show). Use the Globo debate and the Osang interview as examples.
- [ ] **Step 2:** Commit `docs(capstone): showcase text and shot list`.

### Task A7: User test journey

**Files:** Create `docs/capstone/user-test.md`

- [ ] **Step 1:** Write: who the tester is (a journalist or journalism student), the setup (prod URL, password given in person, the Osang interview already analysed), 5–6 tasks in plain words (find what Merkel said about Putin and clip it; check who speaks; make a vertical clip with subtitles; ask a question in Ask and check the answer's timestamp; approve an Ask change; export), what to observe per task (time, hesitations, wrong clicks, trust in AI text), a post-test questionnaire (SUS-style 5 items + 3 open questions), the consent line (recording, anonymised notes), and a results template table. No leading questions.
- [ ] **Step 2:** Commit `docs(capstone): user test journey`.

---

### Task B2: Osang × Merkel interview run and golden file

**Files:**
- Create: `apps/worker/eval/osang-merkel-2022-06-07.golden.json`
- Modify: decisions file (cost, context answers)

- [ ] **Step 1:** With the stack running (digestor-run skill), create a YouTube session for `https://www.youtube.com/watch?v=hiwnD00kV0w` with language `de` through `POST /api/sessions/youtube` (hint: "Interview: Alexander Osang with Angela Merkel, Berliner Ensemble, 7 June 2022, broadcast by phoenix"). Wait for the context check.
- [ ] **Step 2:** Answer the context check from public facts only (profile `interview`; Speaker roles: interviewer Alexander Osang, interviewee Angela Merkel; event, date and place as in the hint). Note each answer and its source (the phoenix video title/description, press reports) in the decisions file. Continue and wait for `ready`.
- [ ] **Step 3:** Draft the golden file from the transcript (`Golden` type in `apps/worker/src/eval/metrics.ts`): 8–12 topics with bounds, 10–15 moments with granularity and highlight types from the `interview` profile, speaker turns for at least 20 minutes, and ≥ 3 traps (`mid_argument`, `quoted_opponent`: e.g. Merkel quoting Putin or critics). `labelledBy`: "drafted by Claude from the transcript (2026-11-13); owner to review".
- [ ] **Step 4:** Run `scripts/eval.ts` with `--run-checks` and save the table output to `docs/capstone/evaluation.md` (new section "Interview: Osang × Merkel"). Record cost.
- [ ] **Step 5:** Commit the golden and the doc. The session stays (B1 and C-tasks use it); it is a test session, so note it in the decisions file for deletion after the owner's review.

### Task B1: Ask/RAG evaluation (retrieval + answers)

**Files:**
- Create: `apps/worker/src/eval/askMetrics.ts`, `apps/worker/src/eval/askMetrics.test.ts`, `apps/worker/scripts/eval-ask.ts`
- Create: `apps/worker/eval/ask/globo-debate.ask.json`, `apps/worker/eval/ask/osang-merkel.ask.json`
- Modify: `docs/capstone/evaluation.md`

**Interfaces:**
- Produces:
  - `type AskGolden = { sessionId: string; labelledBy: string; questions: AskGoldenQuestion[] }`
  - `type AskGoldenQuestion = { id: string; question: string; answerable: boolean; expect: { startMs: number; endMs: number }[]; quote?: string }`
  - `retrievalScores(qs: AskGoldenQuestion[], hits: Map<string, { startMs: number; endMs: number }[]>, k: number): { recallAtK: number; mrr: number; n: number }` (a hit counts when it overlaps any expected span; unanswerable questions are skipped)
  - `answerScores(rows: { q: AskGoldenQuestion; answer: string; citedMs: number[]; quotesFound: boolean[] }[]): { citationHit: number; quoteExact: number; refusalCorrect: number; n: number }` (citation hit: some cited time inside an expected span ±30 s; refusal correct: an unanswerable question answered with `NOT_IN_DATA` or "I couldn't confirm")

- [ ] **Step 1:** Write failing tests for `retrievalScores` (recall 1/2 and MRR 0.75 on a two-question fixture: first hit rank 1, second missing; an unanswerable question doesn't count) and `answerScores` (citation within 30 s counts, 31 s doesn't; refusal on unanswerable counts).
- [ ] **Step 2:** Implement and pass.
- [ ] **Step 3:** `scripts/eval-ask.ts <golden> [--answers] [--k 6]`: retrieval mode (free) calls `searchTranscript` with the real embedder for each question and prints recall@k and MRR. `--answers` (paid) creates an `ask_messages` pair per question under owner `eval`, runs `runAsk`, parses `[hh:mm:ss]` citations and quoted text, prints the scores and the cost from the usage meter, then deletes the `eval` rows. Results go to stdout; the owner keeps `apps/worker/eval/results/` untracked.
- [ ] **Step 4:** Draft both golden files (12 questions each, 2 unanswerable, at least 3 asked in a different language than the video, `expect` spans from the transcript). `labelledBy` says drafted by Claude, owner to review.
- [ ] **Step 5:** Run retrieval mode for both (free) and `--answers` for both once (the "before" numbers, before C1/C2). Write the table into `docs/capstone/evaluation.md` under "Ask (RAG)" with date, model, k, cost.
- [ ] **Step 6:** Commit.

---

### Task C1: Ask on LangGraph with approval before changes

**Files:**
- Create: `apps/worker/src/agents/askGraph.ts`, `apps/worker/src/agents/askGraph.test.ts`, `packages/core/drizzle/0026_ask_graph.sql` (+ meta)
- Modify: `apps/worker/src/agents/ask.ts` (export the tool table and `runTool`; `runAsk` delegates to the graph; new `resumeAsk`), `apps/worker/src/jobs.ts`, `apps/worker/src/main.ts`, `apps/worker/src/cleanup.ts`, `apps/worker/src/sweep.ts`, `apps/worker/package.json`, `packages/core/src/personalTypes.ts`, `packages/core/src/queue.ts`, `packages/core/src/db/personal.ts` (or wherever ask repo functions live), `packages/core/src/db/schema.ts`, `apps/web/app/api/ask-actions/[id]/route.ts`, `apps/web/components/Ask/AskDrawer.tsx`, `apps/web/lib/askText.ts`, `CLAUDE.md`

**Interfaces:**
- Produces:
  - `AskMessageStatus` gains `"waiting"` (paused for approval; not job-owned, the sweep leaves it).
  - `AskActionKind` gains `"tool_approval"`; payload `{ step: number; calls: { id: string; name: string; args: unknown; summary: string }[] }`; `ask_actions.resolution jsonb` (nullable) stores `{ decision: "approve" | "reject" | "edit"; edits?: { id: string; args: unknown }[] }`.
  - Queue `ask.resume` (`QUEUES.askResume`), job data `{ actionId: string }`.
  - `MUTATING_TOOLS: ReadonlySet<string>` = `propose_clip`, `trim_clip`, `set_selection` (C3 adds `make_clip_package`).
  - `buildAskGraph(deps: AskDeps, checkpointer: BaseCheckpointSaver)`; thread id = the assistant message id.
  - `resumeAsk(deps: AskDeps & { checkpointer }, actionId: string): Promise<void>`.
  - `deleteAskThreads(db: Db, sessionId: string): Promise<void>` and `deleteAskThread(db, messageId)` (rows in schema `ask_graph`).

**Graph:** `START → agent → route`; `route` sends to `END` (final text), to `approve` (any call in the turn is in `MUTATING_TOOLS`), or to `tools`. `approve` creates (idempotently: one per message id + step) a `tool_approval` action, sets the message `waiting`, then `interrupt({ actionId })`; on resume it applies the decision (approve: run as asked; edit: replace those calls' args, then validate as usual; reject: every mutating call of the turn returns "The user declined this change." to the model) and goes to `tools`. `tools` runs every call through `runTool` (same validation, `evidence()`, R31 cap) and returns to `agent`. `MAX_ASK_STEPS` counts agent turns as before; serialisable state only (`messages`, `records`, `final`, `steps`, `directChanges`, `wrote`); the DB, LLM and search come from closures.

**Checkpointer:** `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres` on `DATABASE_URL` with schema `ask_graph`; `setup()` once at worker start. A thread is deleted when its message ends `done` or `failed`; `cleanup.ts` calls `deleteAskThreads` with `deleteSessionIndex` (retention), and session deletion does too.

**UI:** The drawer shows a `tool_approval` card under the pending answer: one line per change (the `summary`, e.g. "Make a clip 00:12:03–00:12:41 'Merkel on Putin'"), buttons Approve / Edit / Reject. Edit opens the start/end/title fields for clips and moment checkboxes for selections, then "Approve with changes". Approve and Reject ask nothing more (the card is itself the confirmation); the card is replaced by "Approved" / "Declined" and the answer continues. Copy via the digestor-ui skill.

- [ ] **Step 1:** `pnpm --filter @digestor/worker add @langchain/langgraph@^1.7.4 @langchain/langgraph-checkpoint-postgres@^1.1.3`; check the peer `@langchain/core` range is met (bump `@langchain/core` within ^1 if needed and run the worker tests).
- [ ] **Step 2:** Migration 0026: `ask_actions.resolution jsonb`; `create schema if not exists ask_graph` (the saver creates its tables there on `setup()`).
- [ ] **Step 3:** Failing tests in `askGraph.test.ts` (FakeToolLLM, `MemorySaver`, test DB):
  - a read-only turn (`search_transcript`) answers without a pause, same records as today;
  - a turn calling `propose_clip` pauses: message `waiting`, one pending `tool_approval` action, no clip created;
  - resume with approve creates the clip and the answer finishes `done`, thread deleted;
  - resume with edit uses the edited start/end (snapped) and the title;
  - resume with reject creates nothing and the model sees "The user declined this change.";
  - resuming the same action twice runs once (the second `resumeAsk` finds the message not `waiting` and does nothing);
  - the R31 cap still holds across approved changes (4th change in one question is refused / becomes a bulk confirm).
- [ ] **Step 4:** Implement `askGraph.ts`, wire `runAsk`/`resumeAsk`, the `ask.resume` handler (claim `waiting` → `running` compare-and-set, as `claimAskMessage` does), worker startup `setup()`, thread deletion. Existing `ask.test.ts` must stay green unchanged except where a test asserted a direct change without approval: update those to approve first and say so in the commit message.
- [ ] **Step 5:** Web: `POST /api/ask-actions/[id]` accepts `{ decision: "approve" | "reject" | "edit", edits? }` for `tool_approval` (keeps `confirm`/`dismiss` for `bulk_selection`), resolves compare-and-set (pending → confirmed/dismissed, stores `resolution`), refuses with `VIDEO_REMOVED` when the session's video is gone, then sends `ask.resume`. Route tests: double POST → second 409; reject; edit with invalid args → 400.
- [ ] **Step 6:** Drawer card (digestor-ui), then see it work on the Globo debate session with Playwright (digestor-run): ask "make a clip of the first answer about the economy", approve, check the clip on Prepare. Delete the clip afterwards (it's the owner's session: only the clip this test made).
- [ ] **Step 7:** Retention test in `cleanup.test.ts`: an expired session's `ask_graph` rows go with its index. Sweep test: a `waiting` message is not failed.
- [ ] **Step 8:** CLAUDE.md: Ask paragraph (LangGraph graph, approval before changes, `ask.resume`, `waiting`, `ask_graph` schema and its retention). Commit `feat(ask): LangGraph graph with approval before any change`.

### Task C2: Verify before answering

**Files:**
- Create: `apps/worker/src/agents/verify.ts`, `apps/worker/src/agents/verify.test.ts`
- Modify: `apps/worker/src/agents/askGraph.ts`, `apps/worker/src/agents/ask.ts` (prompt version `ask@5`)

**Interfaces:**
- Produces:
  - `extractQuotes(answer: string): string[]` (text between “ ”, „ “, « », or straight double quotes, ≥ 4 words)
  - `findQuote(quote: string, words: Word[]): { found: boolean; atMs: number | null }` (lowercase, accents and punctuation stripped, whitespace collapsed; substring of the normalised transcript)
  - `citedSentences(answer: string): { text: string; atMs: number[] }[]` (sentences carrying `[hh:mm:ss]`)
  - `judgeClaims(llm: StructuredLLM, claims: { text: string; window: string }[]): Promise<boolean[]>` (one structured call, `fast` model, lenient schema per llm-structured-output; a failed call means "not checked", never "unsupported")
  - `verifyAnswer(deps, answer, transcript): Promise<{ unsupported: string[] }>`
  - `VERIFY_RETRIES = 2`; `COULDNT_CONFIRM = "I couldn't confirm: "`

**Graph change:** `agent` with final text → `verify`. `verify` skips `NOT_IN_DATA`. Quotes not found anywhere in the transcript are unsupported, unless the quote's language differs from the transcript's (e.g. an English rendering of German speech): those go to `judgeClaims` as claims. Each cited sentence is judged against the transcript ±45 s around its timestamps. Unsupported and rounds < `VERIFY_RETRIES` → append a user-role message "Verification: these parts weren't supported by the transcript: … Look again with the tools and correct or drop them." and go back to `agent`. Still unsupported after the retries → the answer is kept with a last line `I couldn't confirm: <parts>`. A `verify_answer` record is added to the chips (result "All checked" / "N parts couldn't be confirmed").

- [ ] **Step 1:** Failing unit tests for `extractQuotes` (German „…“ quote, straight quotes, a 3-word quote ignored), `findQuote` (punctuation/case/accents differences found; a changed word not found), `citedSentences`.
- [ ] **Step 2:** Implement and pass.
- [ ] **Step 3:** Failing graph tests (FakeToolLLM + FakeLLM for the judge): a correct quote passes with one agent turn; a wrong quote triggers one retry and the corrected answer passes; three wrong answers end with `I couldn't confirm:` after exactly 2 retries; the judge failing leaves the answer unchanged with chip "couldn't be checked".
- [ ] **Step 4:** Implement in the graph, pass, run `ask.test.ts` + `askGraph.test.ts`.
- [ ] **Step 5:** Re-run B1 `--answers` on both goldens (the "after" numbers) and add them beside the "before" row in `docs/capstone/evaluation.md`. Record cost.
- [ ] **Step 6:** Commit `feat(ask): verify quotes and cited claims before answering`.

### Task C3: Clip package

**Files:**
- Modify: `apps/worker/src/agents/ask.ts` (two tools), `apps/worker/src/agents/askGraph.ts` (`make_clip_package` in `MUTATING_TOOLS`), `apps/web/components/Ask/AskDrawer.tsx` (package card), tests in `ask.test.ts` / `askGraph.test.ts`

**Interfaces:**
- Produces tools:
  - `find_clip_candidates({ topic: string; count?: 1..5 (default 3); maxSeconds?: number })` (read-only): moments of the current analysis matching the topic first (title/reason text match + `search_transcript`), then search hits snapped with `snapClip`; returns up to `count + 2` candidates `{ start, end, title, why }` as evidence text.
  - `make_clip_package({ clips: { start, end, title }[] (1–5), format: "16:9" | "9:16", subtitles: string | null (language code) })` (mutating): after approval creates the clips (`createClip`, snapped), sets the format, sends `track.prepare` for the language when given, and `clip.render` for each. Burned subtitles stay a manual step (per-language approval rule). The whole package counts as **one** direct change for R31.
- The approval card for `make_clip_package` lists the candidates with checkboxes (the human picks), editable start/end/title, the format and subtitle language; "Make N clips". Prompt line: "For a set of clips ('3 clips on Ukraine for Instagram'), call find_clip_candidates, then make_clip_package with the best ones; Instagram, TikTok, Reels and Shorts mean 9:16."

- [ ] **Step 1:** Failing tests: candidates come from moments first, never more than `count + 2`, all snapped to sentence boundaries; package pauses for approval; approve with 2 of 3 picked creates 2 clips with format 9:16, one `track.prepare` per clip for the language and one `clip.render` each; the package counts as one change; a session with its video removed refuses with the `VIDEO_REMOVED` sentence.
- [ ] **Step 2:** Implement, pass. Check job sending against the pgboss-gotchas skill (claim in DB first where the queue is job-owned).
- [ ] **Step 3:** Drawer card; Playwright on the Osang session: "3 clips on Ukraine for Instagram", pick 2, approve, see them on Prepare rendering. Delete those clips afterwards.
- [ ] **Step 4:** Commit `feat(ask): clip packages with a pick-and-approve pause`.

### Task C4: Ask across videos

**Files:**
- Create: `apps/worker/src/agents/askLibrary.ts`, `apps/worker/src/agents/askLibrary.test.ts`, `packages/core/drizzle/0027_library_ask.sql`, `packages/core/src/db/libraryAsk.ts` (+ test), `apps/web/app/api/library-ask/route.ts`, `apps/web/components/Home/LibraryAsk.tsx`
- Modify: `packages/core/src/db/schema.ts`, `packages/core/src/queue.ts` (`ask.library`), `apps/worker/src/jobs.ts`, `apps/worker/src/sweep.ts` (job-owned rows), `apps/web/app/page.tsx` (or the Home component), `CLAUDE.md`

**Interfaces:**
- Table `library_ask_messages(id uuid pk, owner_id text, role text, text text, sources jsonb, tool_calls jsonb, status text, created_at)`; statuses as `AskMessageStatus` minus `waiting`.
- Graph (LangGraph, no pause, no checkpointer needed: `MemorySaver` per run): `route` (structured call, `fast` model: picks ≤ 5 session ids from candidates `{ id, title, date, profile, summary (≤ 300 chars) }`, only sessions whose Chroma collection exists and whose video isn't removed) → fan-out with `Send` one `search` per picked session (`searchTranscript`, k = 4, through `evidence()`) → `answer` (ToolLLM without tools; cites as `[S2 00:12:03]` where S2 is the session's label in the prompt) → `verify` (C2's `verifyAnswer` per session's transcript) → end. `sources` stores `{ label, sessionId, title }[]`.
- Web: on the Sessions home, an "Ask across videos" button opens a drawer like Ask; citations render as links to `/s/<id>` at that time (use the Briefing page's existing time parameter if it has one; otherwise link the session and show the time). Nothing changes data, so no approval.

- [ ] **Step 1:** Failing tests: routing only offers indexed sessions; a routing answer naming an unknown id is ignored; with no indexed session the reply is "None of your videos can be searched right now (search works for 14 days after upload)."; answers carry sources; verify runs per cited session.
- [ ] **Step 2:** Implement worker side + repo + migration, pass.
- [ ] **Step 3:** Route + drawer (digestor-ui), sweep rows; Playwright on the home page with the Globo debate and Osang sessions indexed: "What did they say about inflation?".
- [ ] **Step 4:** CLAUDE.md, commit `feat(ask): ask across videos (routing, fan-out search, verify)`.

---

### Task D5: Word heat map (no AI)

**Files:**
- Create: `packages/core/src/fightinWords.ts` (+ test), `packages/core/src/monitorStoplist.ts`, `packages/core/src/db/monitorWords.ts` (+ test), `packages/core/drizzle/0028_monitor_words.sql`, `apps/web/components/Monitor/WordHeat.tsx`
- Modify: `apps/worker/src/monitor/` refresh (call `refreshWordCounts` after speeches), `apps/worker/scripts/monitor-backfill.ts`, `apps/web/components/Monitor/DeputyView.tsx` (+ its `SectionNav` entry), `apps/web/components/Monitor/DirectoryView.tsx` (party view when `party` is set), `apps/web/messages/monitor.ts`, `CLAUDE.md`

**Interfaces:**
- Table `parl_word_counts(member_id int, party text not null default '', month date, stem text, n int, primary key (member_id, party, month, stem))`: stems from `unnest(to_tsvector('pt_unaccent', text))`, n = number of positions, party = the speech's party on the day (`''` when null).
- `refreshWordCounts(db: Db): Promise<number>`: one transaction, delete + insert-select over all speeches with text.
- `fightinWords(target: Map<string, number>, rest: Map<string, number>, prior: Map<string, number>, opts?: { alpha0?: number }): { stem: string; z: number; nTarget: number }[]` (Monroe, Colaresi & Quinn 2008, weighted log-odds with an informative Dirichlet prior from the whole chamber; sorted by z desc).
- `distinctiveWords(db, who: { memberId: number } | { party: string }, opts?: { limit?: number (20); minTokens?: number (3000) }): Promise<{ enough: boolean; words: { stem: string; label: string; count: number; months: { month: string; share: number }[] }[] }>`: `label` = the most common surface form in the target's own texts (tokens whose `to_tsvector('pt_unaccent', token)` gives the stem, counted in one batched SQL); `months[].share` = the stem's share of the target's words that month divided by the chamber's share (shown as heat only, never as a number).
- Stoplist: procedural and courtesy words (presidente, senhor, senhora, deputado, deputada, excelência, vossa, sessão, palavra, tempo, minuto, orador, obrigado, Câmara, plenário, requerimento, votação, pela ordem, …) plus stems shorter than 3 letters and numbers.

- [ ] **Step 1:** Failing tests for `fightinWords` on a hand-made 3-word corpus (the word only the target uses ranks first; a word used equally by both has z ≈ 0; the prior keeps a 1-count word below a 20-count one).
- [ ] **Step 2:** Implement, pass.
- [ ] **Step 3:** Migration, `refreshWordCounts`, `distinctiveWords` with DB tests (test DB, two members, stoplist removes "presidente", the surface label is the most common form, under `minTokens` → `enough: false`).
- [ ] **Step 4:** UI: deputy page section "Words used more than the chamber" (`tm` key, pt-BR "Palavras usadas mais que a média da Câmara"): 15–20 words as a list, each with a month-by-month heat row (one cell per month of the year, intensity from `share`, an accessible label "used about as often as the chamber / more / much more" per cell, no numbers), a line "Counted from the official text" and a "How this is counted" disclosure (weighted log-odds, Monroe et al. 2008, stoplist, what it doesn't mean). No word cloud, no scores, no comparisons between deputies. Same section on `/monitor/deputados?party=X`.
- [ ] **Step 5:** Run `refreshWordCounts` locally, Playwright on two deputies and one party at phone and desktop width (digestor-run); check the words make sense (no procedural words). Commit `feat(monitor): words used more than the chamber (weighted log-odds)`.

### Task D1: Monitor search by meaning (hybrid)

**Files:**
- Create: `apps/worker/src/monitor/embedSpeeches.ts` (+ test), `apps/worker/src/http.ts` (+ test), `apps/worker/scripts/monitor-embed.ts`, `apps/worker/scripts/eval-monitor-search.ts`, `apps/worker/eval/monitor-search.golden.json`, `packages/core/src/rrf.ts` (+ test), `packages/core/drizzle/0029_monitor_embeddings.sql`, `apps/web/lib/monitor/semantic.ts` (+ test)
- Modify: `packages/core/src/db/monitor.ts` (`speechesByKeys`), `apps/worker/src/main.ts` (start the HTTP server), `apps/worker/src/jobs.ts` (queue `monitor.embed`, daily 10:00 UTC, after the refresh), `packages/core/src/queue.ts`, `docker-compose.yml` (worker `ports: ["127.0.0.1:8790:8790"]`), `docker-compose.prod.yml` (web env `WORKER_URL=http://worker:8790`), `apps/web/lib/monitor/search.ts`, the topic search view (`LandingView`/`SpeechItem`: "related by meaning" mark), `apps/web/messages/monitor.ts`, `docs/deploy.md`, `CLAUDE.md`

**Interfaces:**
- Chroma collection `monitor_camara_speeches`, cosine; chunk ids `${speechKey}#${i}`; metadata `{ speechKey, memberId, startsAt }`; chunks of whole sentences up to ~1,000 characters (one sentence overlap), from `text` (or `summary` when `text` is empty).
- Table `parl_speech_embeddings(speech_key text pk, chunks int, embedded_at timestamptz)`; `embedSpeeches(deps: { db; chroma; embedder }, opts?: { max?: number }): Promise<{ added: number; removed: number }>` embeds keys with text not in the table and deletes chunks of keys no speech has any more.
- Worker HTTP (node:http, port `WORKER_HTTP_PORT` default 8790, no auth: never published beyond the host's loopback / the compose network): `GET /health`; `POST /monitor/search { q: string; k?: number (≤ 200, default 100) }` → `{ hits: { speechKey: string; score: number }[] }` (best chunk per speech); `POST /monitor/passages { q: string; speechKeys: string[]; perSpeech?: number (3) }` → `{ passages: { speechKey: string; sentences: string[]; score: number }[] }` (sentences of those speeches scored against the query, best first). Errors → 503 JSON, never a crash.
- `rrf(lists: string[][], k = 60): { key: string; score: number; inLists: number[] }[]` (Reciprocal Rank Fusion, Cormack et al. 2009).
- `speechesByKeys(db, keys: string[], filters?: SpeechFilters): Promise<SpeechHit[]>` (same row shape and filters as `searchSpeeches`, in the given key order).
- Web: `semanticSearch(q): Promise<{ keys: string[]; ok: boolean }>` (`WORKER_URL`, default `http://127.0.0.1:8790`, 3 s timeout, cached per query). The topic search for speeches (not `exact=1`, sort "best") takes the word search's top 100 keys and the meaning search's top 100, fuses with `rrf`, applies filters through `speechesByKeys`, and pages over the fused list; rows found only by meaning get a quiet "related by meaning" mark. Sort "new", `exact=1`, mentions and the deputy page's own search stay word-only. Worker down → word results + a quiet note "Search by meaning isn't available right now."
- Golden: `{ labelledBy, queries: { id, q, lang, relevant: { externalId: number; startsAt: string }[] }[] }` (speech identity by member + timestamp, because speech keys change when a text is revised). 20 queries: 14 Portuguese (some using words the speeches don't use: "aumento do preço da comida" vs "inflação dos alimentos"), 6 English. Relevance judged by pooling the top 10 of the three methods and reading the texts; owner reviews.
- `eval-monitor-search.ts` prints recall@10 and MRR for words / meaning / hybrid.

- [ ] **Step 1:** Failing tests: `rrf` (an item in both lists beats items in one; ties keep first-list order); chunker (sentence-aligned, ≤ ~1,000 chars, overlap); `embedSpeeches` with FakeEmbedder + test Chroma (second run adds 0; a revised text removes the old key's chunks); HTTP handler (400 on empty q, 503 when Chroma throws, k capped).
- [ ] **Step 2:** Implement worker side, migration, queue, script; pass. Run `scripts/monitor-embed.ts` locally (all 2026 speeches) and note the time it took (prod will run it once; record in deploy.md).
- [ ] **Step 3:** `speechesByKeys` + web fusion with tests (worker down → word-only + note; filters apply to meaning hits; paging over the fused list is stable).
- [ ] **Step 4:** Golden query set + `eval-monitor-search.ts`; run it, write the table to `docs/capstone/evaluation.md` ("Monitor search"). If hybrid is worse than words on recall@10, say so plainly and keep words as default behind a `meaning=1` switch instead (decision file).
- [ ] **Step 5:** Playwright on the landing search (an English query and a Portuguese paraphrase) at phone and desktop width. docs/deploy.md: prod needs `WORKER_URL` on web and one `monitor-embed` run. CLAUDE.md. Commit `feat(monitor): search by meaning, fused with word search`.

### Task D3: Ask the record (extractive only)

**Files:**
- Create: `apps/web/app/monitor/perguntar/page.tsx`, `apps/web/components/Monitor/AskRecordView.tsx`, `apps/web/lib/monitor/askRecord.ts` (+ test)
- Modify: `apps/web/lib/monitor/params.ts` (route params), `apps/web/components/Monitor/LandingView.tsx` (third door), `apps/web/messages/monitor.ts`, `CLAUDE.md`

**Interfaces:**
- `askRecord(db, q: string, opts?: { from?: string; to?: string }): Promise<{ ok: boolean; passages: { speech: SpeechHit; sentences: string[] }[] }>`: hybrid retrieval as in D1 (top 30), then worker `/monitor/passages` for the best 1–3 sentences of each, at most 2 passages per deputy (diversity, not a ranking), 6 passages shown.
- Page `/monitor/perguntar?q=&from=&to=` (server component, `GetForm`): heading "Ask the record"; each passage: the sentences as a quote, deputy name, party-UF on the day, date, link to the speech on the deputy's page, and the speech's video moment ("Watch at h:mm:ss", reuse `SpeechVideo`). A fixed line: "These are passages from the official record, chosen by similarity to your question. Nothing here is written by AI." No generated text anywhere. Worker down → "Asking the record isn't available right now. Try the word search." with a link carrying `q`.

- [ ] **Step 1:** Failing tests for `askRecord` (≤ 2 per deputy; worker down → `ok: false`; passages keep the record's sentences verbatim) and params parsing (invalid dates ignored).
- [ ] **Step 2:** Implement, pass; page + landing door (digestor-ui spacing, `tm` copy in both languages).
- [ ] **Step 3:** Playwright: "What did deputies say about the price of food?" and a Portuguese question. Commit `feat(monitor): ask the record, quoted official passages only`.

### Task D2: Clip this speech

**Files:**
- Create: `apps/web/app/api/monitor/clip/route.ts` (+ test), `packages/core/drizzle/0030_session_source_range.sql`
- Modify: `packages/core/src/db/schema.ts` (`sessions.source_start_ms`, `source_end_ms` nullable), `packages/core/src/db/repo.ts` (`createSession` accepts the range), `apps/worker/src/youtube/ytdlp.ts` (`ytDlpArgs` adds `--download-sections "*<s>-<e>"` when a range is set) + test, wherever the app builds "open on YouTube at" links for a session (add `source_start_ms`), `apps/web/components/Monitor/SpeechItem.tsx` or `SpeechVideo.tsx` (button), `apps/web/messages/monitor.ts`, `docs/deploy.md`, `CLAUDE.md`

**Interfaces:**
- `POST /api/monitor/clip { speechKey: string }` → `{ sessionId }`: looks up the speech's video moment (`parl_speech_videos`), creates a YouTube session for `https://www.youtube.com/watch?v=<videoId>` with range `[start_s − 20, end_s + 20]` seconds (clamped at 0), language `pt`, hint "Câmara dos Deputados plenary: speech by <name> (<party>-<UF>) on <date>", and links the speech's official record when the existing record input accepts a Câmara reference for that day; then `sendStart`. 404 when the speech has no video moment.
- Env `MONITOR_CLIP_ENABLED=true` turns the button on (missing = off). Off: the button is replaced by the line "Clipping downloads the video from YouTube, which this server can't do. Open the monitor on your own computer to clip this speech." On: "Clip this speech" (confirm dialog: "Open this speech as a new Digestor session? It downloads about N minutes of video.") then navigates to `/s/<id>`.
- Times inside the new session are relative to the downloaded section; links back to YouTube add `source_start_ms`.

- [ ] **Step 1:** Failing tests: `ytDlpArgs` with a range adds the section flag and keeps cookies handling; route: no video moment → 404, disabled flag → 403 with the sentence above, valid → session row with the range and hint, `sendStart` called once.
- [ ] **Step 2:** Implement, migrate, pass (worker tests in the container).
- [ ] **Step 3:** Locally with `MONITOR_CLIP_ENABLED=true`: clip one short speech that has a video moment, wait until the context check, check the transcript starts at the speech; the "Open on YouTube at" link lands on the right second. Delete that session afterwards. Record the AssemblyAI cost.
- [ ] **Step 4:** deploy.md (flag stays off on prod unless the owner turns it on), CLAUDE.md. Commit `feat(monitor): clip this speech into a Digestor session`.

---

### Task D6: Filters for a deputy's votes and bills (added by the owner 2026-11-13)

**Files:**
- Modify: `packages/core/src/db/monitor.ts` (`listMemberVotes` filters), `packages/core/src/db/monitorRecord.ts` (authored bills filters), `apps/web/lib/monitor/params.ts` (+ test), `apps/web/components/Monitor/DeputyView.tsx`, `apps/web/components/Monitor/AuthoredBills.tsx`, `apps/web/components/Monitor/VoteRow.tsx` (or the votes section component), `apps/web/messages/monitor.ts`, `CLAUDE.md`
- Create (part 2, after D1): vote/bill entries in the worker's meaning index and its use in the two text boxes

**Interfaces:**
- Params (deputy page, parsed and built in `params.ts`, invalid values ignored): votes `vq` (text), `vv` (`sim|nao|abstencao|obstrucao`), `vk` (`bill|request`), `vfrom`, `vto` (YYYY-MM), `vdiff=1`, `vp` (page, resets when a filter changes); bills `bq` (text), `byear`, existing `btype`, `bp`.
- `listMemberVotes(db, memberId, a: { limit?; offset?; q?: string[] (search terms); vote?: string; kind?: "bill" | "request"; from?: string; to?: string; differsFromGuidance?: boolean })`: text matches the roll call's description + bill label + bill summary with `pt_unaccent` full-text (same term handling as `searchSpeeches`, incl. the existing query translation and `exact`-style escape hatch); `kind` uses the same rule as the existing "Vote on a request" marker (`lib/monitor/votes.ts`); `differsFromGuidance` = the guidance that applies to the deputy's party at the vote (match party → bloc exactly as the roll-call page does) is one of Sim / Não / Obstrução / Abstenção and the deputy's vote differs; empty guidance or "Liberado" never counts. Returns the same row shape plus `guidance: string | null` for each row.
- Bills: `bq` over the bill summary (full-text, same handling), `byear` = year presented.

**UI:** Each section gets a compact filter row (GetForm, phone-first: text box + the selects; "Different from the party's guidance" as a checkbox), and a line "N of M recorded votes" / "N of M bills" under it (counts of this deputy's own records only — never compared with others). Each vote row shows the party guidance next to the vote when there is one ("Party guidance: Sim"). Label copy (en / pt-BR via `tm`): "Different from the party's guidance" / "Diferente da orientação do partido", with a short note: "Compared with the guidance the party (or its bloc) gave for that vote. A free vote ('Liberado') or no guidance never counts." No ranking, no %, no judgement words ("rebel", "disloyal").

- [ ] **Step 1:** Failing tests: params parse/build round-trip (invalid values dropped, page reset); `listMemberVotes` on the test DB: each filter alone and combined, `differsFromGuidance` with party guidance, bloc guidance, "Liberado", empty guidance, no guidance row; bills `bq` + `byear`.
- [ ] **Step 2:** Implement, pass; UI rows + counts (digestor-ui), copy in both languages.
- [ ] **Step 3:** Playwright at 390 px and desktop on a deputy with many votes: each filter, the guidance checkbox, paging, Back. Commit `feat(monitor): filters for a deputy's votes and bills, incl. different from party guidance`.
- [ ] **Step 4 (part 2, after D1):** embed roll-call descriptions + bill summaries in the worker's meaning index (own collection, same chunk-free short texts), fuse with the word results in `vq` / `bq` exactly as D1 does for speeches (worker down → words only + quiet note), 8 golden queries (4 votes, 4 bills) in the D1 golden file with recall@10/MRR. Commit `feat(monitor): search votes and bills by meaning`.

### Task D7: Audio check (added by the owner 2026-11-13; audio-only support exists since Plan 2)

**Files:** whatever the end-to-end run shows broken (expected: `apps/web/components/Briefing/*`, `Prepare/*`, `Names/*`, `Export*`, `apps/worker/src/pipeline/*`, `apps/worker/src/media/ffmpeg.ts`); tests beside each fix; `docs/capstone/evaluation.md` (a short "Audio-only run" note, no golden).

- [ ] **Step 1:** In the worker container (never on the host), cut a 10-minute mp3 from the Osang session's original (`ffmpeg -ss 600 -t 600 -vn -c:a libmp3lame -q:a 4`), into the scratchpad or a temp dir, not `data/` of another session.
- [ ] **Step 2:** Upload it through `POST /api/sessions/upload` with `audioOnlyAck=1` (language `de`), answer the context check if it pauses, wait for `ready`. Record cost (~US$0.10 cap).
- [ ] **Step 3:** Walk the flow with Playwright at 390 px and desktop: Processing steps (no picture steps), Context check / Who's who voice samples, Briefing (moment rows show the small audio player, no broken image slots or empty thumbnail boxes), Ask (no "watch" wording that assumes video), Prepare (audio preview, 9:16 option hidden or explained), subtitle track, a rendered clip (waveform + subtitles), Export "Download all". Console clean.
- [ ] **Step 4:** Fix each gap with a test (UI copy via digestor-ui); never weaken a video path.
- [ ] **Step 5:** Delete the test session and its files; commit `fix(audio): audio-only sessions end to end` (or `test(audio)` if nothing needed fixing), with screenshots listed in the report.

### Task A6: "Why not LangGraph" PDF

**Files:**
- Create: `reports/src/langgraph.html` (+ inline SVG diagrams, local CSS), `reports/langgraph-why-not.pdf` (git-ignored, rendered with headless Chrome: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --print-to-pdf=… --no-pdf-header-footer file://…`)

- [ ] **Step 1:** About 10 A4 pages for the owner preparing the review answer, in this order: (1) one-page answer in plain words; (2) what LangChain is (models, messages, tools, structured output, adapters) and what LangGraph is (state graph, nodes/edges, checkpointer, `interrupt()`/`Command`, `Send`), how they connect; (3) why the pipeline used LangGraph (spec 2026-10-28: two human pauses lasting days → checkpointer + interrupt; a001621, 2026-10-29) with a diagram of that first graph; (4) why it was a weak fit even then (clip review = many actions, not one resume; the model never chose the control flow); (5) what changed (Plan 2 removed the review pause → one pause, a straight line of 10 steps, tiny state; costs: checkpoint tables holding context answers past retention, `invoke(null)` pitfall, re-paid transcription risk, seeded sessions couldn't resume; owner 2026-11-06 "pipeline is very trivial"; tidy-up, not a saving) with the 10-step diagram; (6) the replacement (3cdd515, 2026-11-09: `pipeline_runs`, compare-and-set, the pause in the same transaction) with a sequence diagram; (7) LangChain kept (structured output, provider adapters, Ask tool calling); (8) where LangGraph does fit now: Ask (C1 approval interrupt, C2 verify loop, C3 pick pause, C4 routing + `Send` fan-out), with the Ask graph diagram as built; (9) likely review questions with short answers; (10) references (LangGraph docs on interrupts/persistence, Anthropic "Building effective agents" (2024) on workflows vs agents, Yan et al. 2024 Corrective RAG, Asai et al. 2023 Self-RAG, Cormack et al. 2009 RRF, Monroe et al. 2008, Es et al. 2023 RAGAS). Facts from git (`git log`, `git show a001621`, `3cdd515`, `933f5d2`) and the plans in `docs/superpowers/plans/`; every date checked against git.
- [ ] **Step 2:** Render, read every page as an image (Read tool on the PDF), fix overflow and contrast, re-render. Send it to the owner with SendUserFile. No commit for `reports/` (git-ignored); commit nothing here unless `reports/src` is tracked by the repo's rules (check `.gitignore`).

### Task A5: Presentation outline

**Files:** Create `docs/capstone/presentation.md`

- [ ] **Step 1:** 10-minute outline in SCR (situation, complication, resolution) covering the six points (problem, solution, data, evaluation, challenges, what's next), one slide per block with the message, the visual, the numbers from `docs/capstone/evaluation.md` (B1 before/after, B2, D1), and speaker notes; a SMART goal line for what's next (Câmara monitor, D4 topic labels, 2023–25 history, sign-in for the 1 Dec demo); 5 likely Q&A questions with answers (including "why not LangGraph", pointing to the PDF). Commit `docs(capstone): presentation outline`.

### Task Z: Whole-branch review and wrap-up

- [ ] **Step 1:** Fresh reviewer on the whole branch diff against this plan and the brief (most capable model). Fix what it finds.
- [ ] **Step 2:** `pnpm typecheck`, `pnpm test`, `pnpm test:worker` green; delete test sessions/clips/collections this run created (not the Osang session until the owner has reviewed it; list it); CLAUDE.md complete for every new queue, table, route and env var.
- [ ] **Step 3:** Final report to the owner: what was built, numbers, total spend, decisions to review, what needs their word (merge, push, prod deploy with migrations 0026–0030, `monitor-embed` on prod, `WORKER_URL`).
