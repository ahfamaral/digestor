# AI goes first (2026-11-21) — design

Repo: `~/Projects/gh-projects/turing-college/capstone` (Digestor). Committed on branch `ai-goes-first` (21 Nov).

Source: the capstone review (20 Nov), the owner's answers on 21 Nov, mockups A1/A2 at https://claude.ai/artifact/LLkaT3Sk3DeN35ikE4N3cF.

## Why

The review: "make AI the centre of the user experience. Currently, the workflow asks users to make several manual decisions before reaching the chat, which makes the AI feel like a supporting feature." The reviewer's picture: start with a request ("Create three short clips about education, with English subtitles, for social media"), the AI asks what it needs, proposes scenes and a draft for approval, then the user refines by chat ("Include the question before this answer", "Make the second clip shorter", "Choose a less confrontational moment"). Manual trimming and subtitle editing stay for precise fixes.

Most of this already exists in Ask (clip packages, trims, approval cards), but Ask only opens with `/` on the Briefing, after processing, and it can't see or change clips that already exist. This change puts Ask first without changing what Digestor is.

It is also the owner's portfolio and interview story ("the reviewer said the AI felt secondary; I made it the entry point"), so the reviewer's request must work end to end on a real video.

## Owner decisions (21 Nov)

- **Approach A** (below). B and C must stay possible later without throwing this work away.
- **Work started in chat can always be continued by hand**, and the reverse. Nothing the agent makes lives outside the normal Briefing / Prepare / Export data.
- The core rule stays: **the AI proposes, the journalist decides.** Every manual screen stays where it is.
- Built Sat 21 – Sun 22 Nov, before sign-in (23–25 Nov) and the feature cut-off (Fri 27 Nov). Time is not the constraint: all six goals are in scope, nothing is cut.
- **Production:** deployed on Sunday 22 Nov only after everything in "Done when" passes **and the owner gives explicit permission** in chat. Until then it stays on its branch and runs locally.
- **Build starts only when the owner says "banana".** Approving this document is not the go signal.

## Approaches

| | What it is | Cost | Outcome |
|---|---|---|---|
| **A · AI goes first** | Goal asked at upload; Ask starts on it when the video is ready and opens docked beside the Briefing; Ask also on Prepare; new agent tools to refer to and change existing clips; clarifying question as a real step | ~1 evening, low risk | **Picked** |
| B · Chat studio | A, plus a new session screen: chat as the main column, draft clips beside it, tabs to Briefing / Prepare / Export | 1.5–2 days | Later (after 1 Dec), on top of A |
| C · Chat from the start | B, plus a chat home page; upload, progress and the context check happen in the conversation; manual steps become a side view | 4–5 days, touches the pipeline pause | Later, only if users prefer it |

A was picked because it delivers the review's main point tonight, leaves the pipeline and the context check untouched before the 1 Dec demo, and every part of it is reused by B and C.

## Goals

### 1. Goal at upload
- `/new` gets a prominent optional field **"What do you want from this video?"** (mockup A1) above the existing optional details, with 3 suggestion chips that fill it ("3 clips for Instagram", "The heated exchanges", "Everything one speaker says about a topic").
- Stored in a new nullable column `sessions.goal` (max 500 characters, the same cap as an Ask question). It is separate from `sessions.hint`, which stays the context agent's input.
- Empty goal = today's behaviour exactly.

### 2. Ask starts on the goal when the video is ready
- At the single point where a session becomes `ready`, if `goal` is set and the session has no Ask messages yet: store the goal as the user's first Ask message and enqueue the Ask job, exactly as the POST `/api/sessions/[id]/ask` route does. Extract that logic into one shared function used by both.
- Idempotent: a re-analysis, a worker restart or a second "ready" never starts it twice.
- If the Ask job fails, the session is still ready and usable by hand; the conversation shows the failure like any failed answer.

### 3. Ask is the first thing you see
- Split `components/Ask/AskDrawer.tsx` into **AskThread** (messages, approval and package cards, the input) and the **frame** (today's drawer). B and C will reuse AskThread in other frames.
- **Desktop (≥1024 px):** on the Briefing, Ask opens docked by default **when the session has a goal** (mockup A2). Sessions without a goal open exactly as today, even if they have Ask history. The user can close it; the choice is remembered per session in the browser. *(Builder-check call: the goal rule wins, so existing sessions don't change.)*
- **Briefing shows Ask's moments only after approval**, as today. Mockup A2's "3 moments proposed by Ask" marker on the topic card is not in scope: candidates live in the package card until the user approves them. *(Builder-check call.)*
- **Phone:** no auto-opening sheet over the page. A banner at the top of the Briefing: "Ask has a draft for you" + Open.
- **Ask on Prepare:** the same per-session conversation is available on Prepare (button + `/`), docked the same way on desktop. Changes made from Ask refresh the Prepare page.
- Ask's answers that make or change a clip link to it in Prepare (`#clip-<id>`).

### 4. The agent can refer to and change existing clips
New tools in `apps/worker/src/agents/ask.ts`, with the existing limits (approval before any change, `MAX_DIRECT_CHANGES`, sentence snapping):

- **`list_clips`** (read-only): this owner's clips in this session, numbered **exactly as the user sees them in Prepare's clip index**, with title, start/end, duration, format, subtitle languages and their status, render status, open checks, and whether Ask made it. The system prompt says: when the user names a clip by number or title, call `list_clips` first.
- **`get_clip_context(clipId, seconds)`** (read-only): the transcript just before and after a clip, with speakers, so the agent can find "the question before this answer" or "where the argument continues". Default 60 s each side, max 180.
- **`update_clip(clipId, …)`** (mutating, approval card): change format (16:9 / 9:16; crop offset resets to centre), title, credit line, and add a subtitle language (queues a subtitle draft, like a package does). Counts as one change. It cannot burn in subtitles, export or approve subtitles: those stay on Prepare.
- **`replace_clip(clipId, start, end, title)`** (mutating, approval card; owner decision 21 Nov): swaps an existing clip to a different moment in one step. It keeps the clip's place in the list, format, crop, credit and subtitle languages; points the clip at a new personal moment (origin "ask") with the new times; resets the clip's checks and acknowledgements and queues the checks for the new moment; re-drafts its subtitle languages for the new text. The old moment is kept so **Undo restores the old clip exactly**. Counts as one change and bumps the edit version.
- Existing `trim_clip` covers "shorter", "include the question" (after `get_clip_context`), and "extend". "A less confrontational moment instead of clip 2" is `list_moments` / `search_transcript` to find candidates, then `replace_clip`; the prompt gets one line on picking alternatives by the moment's highlight type and reason, and on using `replace_clip` (not `propose_clip`) when the user says "instead of".

### 5. Clarifying questions as a real step
- New terminal tool **`ask_user(question, options[2–4])`**: ends the answer with one short question and quick-reply options (mockup A2: "Which platform? Instagram / TikTok (9:16) · X / YouTube (16:9)"). Stored with the assistant message; AskThread renders the options as buttons; clicking one sends it as the next user message. Typing a free answer also works.
- Prompt rule: ask only when a missing answer would change the result (platform/format, number of clips, subtitle language, which person or topic when ambiguous); at most one question before acting; never ask what the transcript or the request already answers.

### 6. Chat and manual stay in sync
- **Stale approval cards:** when a card is built, it records each affected clip's **edit version**. On Approve, if any of those clips changed since (e.g. trimmed by hand in Prepare), nothing is applied; the card shows "Clip 2 changed since this card was made. Ask again." Same for clips deleted in between.
  - The edit version is a new counter on `clips`, bumped only by changes to what a card can change: start/end, format, crop, title, credit, subtitle languages (added or removed). Renders, checks, acknowledgements and subtitle cue edits don't bump it. `updated_at` can't be used because renders bump it. *(Builder-check call.)*
- **"Made with Ask"** tag on clips Ask created, in Prepare's clip index and editor.
- Manual edits are what `list_clips` returns, so "make clip 2 shorter" after a manual trim starts from the manual version.

## Non-goals (this change)

- The Studio screen (B), the chat home page and chat-driven upload / context check (C).
- Using the goal to steer the analysis (topics, moments). Possible later via the existing `findMore` pattern.
- Token streaming in Ask (polling stays), a new model, changes to `askLibrary`.
- Accounts and sign-in (23–25 Nov), anything in the Câmara monitor.

## Anti-goals (a failure even if it works)

- Any manual path gets harder or hidden: the stepper, Briefing filters, Approve / Skip, "Prepare clips", Prepare and Export behave exactly as today when Ask is closed or the goal is empty.
- The agent changes anything without an approval card, or the change caps go up.
- An approval card silently overwrites a manual edit.
- The phone view gets a sheet that covers the page on arrival.
- The demo on 1 Dec is put at risk: no change to the monitor, the pipeline steps or the context check.

## Constraints

- Follow the repo's `CLAUDE.md` conventions (strict TS, ESM, zod schemas in `packages/core`, one Drizzle migration numbered after whatever `main` holds when this merges, so it doesn't clash with sign-in's, all copy in `apps/web/messages/en.ts`, shadcn / base-ui primitives).
- Tests: Vitest with the real Postgres test DB (`TEST_DATABASE_URL`). All suites green before merge.
- Cost: the auto-start spends one Ask turn per video with a goal (Ask measured ~$0.003 per question on Haiku; the default reasoning model costs more). No other new model calls.
- Feature cut-off Fri 27 Nov; production frozen Mon 30 Nov.

## Done when

1. On a local session of the Globo debate, the reviewer's request typed at upload produces, without any other click: Ask open beside the Briefing, one clarifying question with options, then a package card with candidates. Approving it makes clips that appear in Briefing, Prepare and Export.
2. In Ask: "include the question before clip 1", "make clip 2 shorter", "make clip 3 for X with Portuguese subtitles" (→ 16:9 + Portuguese draft), "choose a less confrontational moment instead of clip 2" each end in a correct approval card and a correct change (the last one replaces clip 2, still three clips; Undo brings the old clip 2 back).
3. Trim clip 2 by hand in Prepare while an Ask card for clip 2 is pending → Approve refuses with the stale message.
4. Goal left empty → no Ask auto-start, Ask closed, everything as before.
5. Tests: `list_clips` numbering matches Prepare; `update_clip` plan and apply; `get_clip_context` bounds; `ask_user` stored and rendered as options; auto-start runs once and only with a goal; stale-card refusal; AskThread renders in the drawer and on Prepare. Existing Ask eval (`eval-ask.ts`) still runs; numbers within the known noise.
6. README "How it works" and the Ask section updated; a short before/after screen recording for the portfolio.

## After this change (owner's request, 21 Nov)

Sequenced after A is built and merged, each as its own step with the owner's approval before anything is applied:

1. **UI/UX review of the whole project** (journalist flow and the Câmara monitor): navigation, usability and accessibility (WCAG AA: contrast, keyboard, focus, labels, touch targets, phone layouts). Output: a ranked list of findings with screenshots; fixes only after the owner picks them.
2. **Brand definition proposal**: one colour pattern and type system applied across Digestor and the monitor (tokens for light and dark, components, usage rules), proposed as a browsable design system before any code changes. Known starting point: the brand orange `#c2410c` with white text fails AA for small text (noted in the 6 Nov UX batch).

## Left to the builder

- Where exactly the session flips to `ready` (`settlePreview` or the end of `analyze`) and the idempotency mechanism.
- The clip numbering source (whatever Prepare's `ClipIndex` uses), the clip version column, and how `ask_user` options are stored (a field on `ask_messages` or in `tool_calls`).
- Exact copy, within the mockups' wording.
