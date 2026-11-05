# Owner Review Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 13 topics the owner approved on 2026-11-05. They cover confirm dialogs, media that pauses when you leave, one Briefing page with a moment tree, a clearer trim strip with Alt free cuts, honest Export with a player, readable subtitle styles, and a sessions list.

**Architecture:** Most of the work is in `apps/web`. Pure logic goes in `lib/` with vitest tests, and screens are verified with Playwright through the `digestor-run` skill. Core gets new exact values and repo functions:
- a selection status merge (Neutral and Rejected become **Skip**, stored as `rejected`);
- subtitle style and position on `clips`;
- snap helpers.

The worker's only change is `buildAss` and the burn signature. Preview and Full briefing merge into one client component, `components/Briefing/Briefing.tsx`, served at `/s/[id]`.

**Tech Stack:** TypeScript (strict, ESM), Next.js 16 (App Router, Cache Components, Turbopack), Base UI shadcn (`base-nova`), Drizzle + Postgres, pg-boss, vitest, Playwright, ffmpeg/libass (worker container only).

**Spec:** `docs/superpowers/specs/2026-11-05-digestor-owner-review-batch-design.md` (approved 2026-11-05). Executors read the spec and this plan together. The spec gives exact copy and the "why". This plan gives files, names, order and tests.

## Global Constraints

- Branch **`review-batch`**. This supersedes the spec's "Branch: plan-4-task-12 / nothing committed". Commit per task on `review-batch`. **Merging to `main` needs the owner's word.**
- Follow `CLAUDE.md` and the `digestor-ui` skill:
  - copy goes in `apps/web/messages/en.ts` via `t()`, never inline;
  - use tokens, not new hex values;
  - errors are friendly and inline (`role="alert"`); progress uses `role="status"`;
  - every icon-only button has an `aria-label`;
  - put `lang` and `dir="auto"` on transcript text and titles.
- Read `nextjs16-gotchas` before touching pages, route handlers or `next.config`. Read `pgboss-langgraph-gotchas` before touching worker job code.
- `@digestor/core` is client-safe; DB code comes from `@digestor/core/server`. Relative imports in core end in `.ts`; in the worker they end in `.js`.
- **No ffmpeg or yt-dlp on the host.** Worker tests run in the container: `docker compose run --rm worker pnpm --filter @digestor/worker test <pattern>`.
- **Disk:** run `df -h /` before any Docker run or build. If less than 16 GB is free, **tell the owner** (it was 19 GB on 2026-11-05 13:04). Docker builds need at least 15 GB.
- Run `date` before writing any status table, and never invent times.
- Exact values, copied verbatim:
  - Subtitle styles `yellow` | `white` | `white_box`; positions `bottom` | `above_banner` | `top`.
  - Yellow is `#FFE600`, which is ASS `&H0000E6FF`.
  - Font is 5.5% of height. Margins: bottom 6%, above banner 22%, top 5% of height. Outline is 4 px at 1080p (scaled by height), shadow 1 px at 1080p. The box is at 75% opacity.
  - Default position by profile: `above_banner` for `parliament`, `supreme_court`, `trial`, `un`; `bottom` for `interview`, `electoral_debate`, `other`.
  - Default style: the owner's most recently updated live clip's style, else `yellow`.
  - Stepper: **Upload › Processing › Context › Briefing › Prepare › Export**.
  - The selection statuses the API stores are `approved` | `rejected`. The UI says "Approve"/"Approved" and "Skip"/"Skipped".
  - Briefing status filter values: `open` (default: no selection, or approved) | `all` | `approved` | `skipped`.
- No letter shortcuts anywhere. `/` opens Ask and Escape closes it. The in-control keys stay (trim handles, fields, name search).
- The word "burn" never appears in user-facing copy after Task 12.
- Every new string, including dialog copy, comes from the spec where the spec gives it.

## Review Focus

1. **Typed or dragged times arrive in tenths** (`hh:mm:ss.s`), but stored edges are whole ms. If an untouched edge is sent back as `00:01:02.3` for a stored `62345`, the server must treat it as unchanged and keep `62345` verbatim, not snap or move it. That's why the changed-edge rule uses a 100 ms tolerance. Pinned in Task 11 (`snapEdges` / `freeEdges` tests).
2. **Bad nesting data in moments:** an `insideMomentId` pointing at itself, at a missing id, at a finer moment, or forming a cycle. The tree must still list every moment exactly once and never loop. Pinned in Task 6.
3. **Old URLs and shared links:** `/s/<id>/briefing?g=passage&show=neutral` must land on `/s/<id>` with the query kept. Unknown or legacy values (`g`, `show=neutral`, `show=rejected`) fall back to defaults without crashing. Pinned in Task 6 (`fromSearchParams`) and Task 7 (redirect check).
4. **Stored Ask actions that still say `neutral`:** pending bulk confirmations and undo maps in `ask_actions` and tool records were written before the merge. Parsing and undoing them must map `neutral` → `rejected` and never answer 400. Pinned in Task 5.
5. **A style change while a subtitle video is being made:** the burn that finishes must end `stale`, not `done`. `finishTrackBurn` compares a signature that includes style and position. Pinned in Task 13.

---

## Wave 1: one Briefing page and the shared pieces it uses

### Task 1: Players pause when their page is hidden (#2)

**Files:**
- Create: `apps/web/lib/usePauseWhenHidden.ts`, `apps/web/components/MediaPlayer.tsx`
- Modify: `apps/web/lib/media.ts` (add `pauseAllMedia`), `apps/web/lib/media.test.ts`
- Modify (use `MediaPlayer` or the hook): `components/Preview/BriefingDoc.tsx` (HighlightRow player), `components/Briefing/MomentRow.tsx`, `components/Prepare/PrepareList.tsx`, `components/Ask/AskDrawer.tsx`, `components/Names/WhosWho.tsx` (hidden sample player, use the hook), `components/ContextCheck.tsx` (hidden sample player, use the hook)

**Interfaces:**
- Produces:
  - `pauseAllMedia(root?: Pick<Document, "querySelectorAll">): number`. It pauses every `video, audio` that is not `paused` and returns how many it paused. Task 2 uses it.
  - `usePauseWhenHidden(ref: React.RefObject<HTMLMediaElement | null>): void`.
  - `<MediaPlayer kind="video" | "audio" src={string} label={string} autoPlay? className? tracks?={{ src: string; srcLang: string; label: string }[]} />`. It renders `controls preload="none"` and calls the hook inside. Tasks 7 and 15 use it.

- [ ] **Step 1: Write the failing test** in `lib/media.test.ts`:

```ts
it("pauseAllMedia pauses only playing elements and counts them", () => {
  const a = { paused: false, pause: vi.fn() }, b = { paused: true, pause: vi.fn() };
  expect(pauseAllMedia({ querySelectorAll: () => [a, b] as never })).toBe(1);
  expect(a.pause).toHaveBeenCalledOnce();
  expect(b.pause).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** `pnpm --filter @digestor/web test media`. Expected: FAIL, `pauseAllMedia` is not exported.
- [ ] **Step 3: Implement** `pauseAllMedia`, the hook and `MediaPlayer`. In the hook, take the element in a `useLayoutEffect(..., [])` body and pause it in the cleanup. React runs layout-effect cleanups when an `<Activity>` boundary hides, so this covers every navigation away. Replace the inline `<video>`/`<audio>` in the files above with `MediaPlayer`. Hidden sample players keep their own elements and refs and add the hook.
- [ ] **Step 4: Run** `pnpm --filter @digestor/web test media`, then `pnpm typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Verify in the browser** (`digestor-run`, a `ready` session). Write a scratch Playwright script:
  1. Play a moment on Preview.
  2. Click the stepper's Prepare (or any link away).
  3. Evaluate `[...document.querySelectorAll('video,audio')].filter(m => !m.paused).length`. It must be `0`.
  4. Go back. The player shows paused at its position.
- [ ] **Step 6: Commit** `feat(web): pause players when their page is hidden`.

### Task 2: Shared ConfirmDialog, first used by "No name" (#1)

**Files:**
- Create: `apps/web/components/ConfirmDialog.tsx`
- Modify: `apps/web/components/Names/NamePopover.tsx`, `apps/web/messages/en.ts`

**Interfaces:**
- Consumes: `pauseAllMedia()` (Task 1); `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription` and `DialogFooter` from `components/ui/dialog.tsx`.
- Produces: `<ConfirmDialog open onOpenChange={(o: boolean) => void} title={string} description={string} actionLabel={string} busyLabel?={string} onConfirm={() => Promise<void>} />`.
  - On the transition to open it calls `pauseAllMedia()`, which never resumes anything.
  - Initial focus goes to Cancel, via Base UI `initialFocus` on the popup with a ref to Cancel.
  - Escape and an outside click close it.
  - Cancel is an outline button; the action is the brand button on the right.
  - Confirm runs `onConfirm`. While it runs, the action shows `busyLabel` and both buttons are disabled. A throw keeps the dialog open with the error's message inline (`role="alert"`). On success it closes.
  - **Enter must not confirm from the initial focus.** Cancel is focused, so Enter activates Cancel. Don't wrap it in a `<form onSubmit>`.

- [ ] **Step 1: Add strings** to `en.ts` under a new `confirm` group: `cancel: "Cancel"` and `failed: "That didn't work. Try again."`. Under `names`, add the spec copy:
  - `noNameTitle: "Remove the name from {voice}?"`
  - `noNameBody: "{name} will be removed from {where}. You can name the voice again later."`
  - `noNameMarkTitle: "Mark {voice} as no name?"`
  - `noNameMarkBody: "{voice} will be shown as no name in {where}. You can name the voice again later."`
  - `noNameWhole: "the whole video"`
- [ ] **Step 2: Implement `ConfirmDialog`.**
- [ ] **Step 3: Wire it into "No name"** in `NamePopover.tsx`. Clicking "No name" closes the popover and opens a `ConfirmDialog`, rendered outside the popover's popup. The current `send({ action: "anonymous", … })` call becomes its `onConfirm`, which throws on failure so the dialog shows the error. Copy: the "named" title and body when `label.badge !== null`, else the "mark" pair. `{where}` is the formatted range (`hh:mm:ss–hh:mm:ss`) when the change applies to a part, else `noNameWhole`.
- [ ] **Step 4: Run** `pnpm typecheck`. Expected: clean.
- [ ] **Step 5: Verify in the browser** in Who's who on a ready session:
  1. Play the sample, then click "No name". The sample pauses, and focus is on Cancel (`document.activeElement` text is "Cancel").
  2. Press Enter. The dialog closes, the name is still there, and the sample stays paused.
  3. Open it again and press Escape. It closes and the name is unchanged.
  4. Confirm. The name is removed. Undo it by naming the voice again.
- [ ] **Step 6: Commit** `feat(web): shared confirm dialog; "No name" asks first`.

### Task 3: One designed dropdown everywhere (#14)

**Files:**
- Create: `apps/web/components/ui/select.tsx` (`pnpm --filter @digestor/web exec shadcn add select`), `apps/web/components/Dropdown.tsx`
- Modify the 10 native selects:
  - `Preview/BriefingDoc.tsx` (Read in)
  - `Preview/Preview.tsx` (ReanalyzeDialog profile)
  - `Briefing/Controls.tsx` ×2
  - `UploadForm.tsx`
  - `ContextCheck.tsx` ×2
  - `Names/RecordHouseSelect.tsx`
  - `Prepare/SubtitlesPanel.tsx`
  - `ReportProblem.tsx`

**Interfaces:**
- Produces: `<Dropdown<V extends string> value={V} onValueChange={(v: V) => void} options={{ value: V; label: string; lang?: string }[]} aria-label?={string} id?={string} disabled?={boolean} size?="sm" | "md" className?={string} />`.
  - It's a white popup with `border-border`, rounded corners, Inter, and an ink-colour check mark.
  - It's keyboard and screen-reader accessible through Base UI.
  - A `<label htmlFor={id}>` must still name it.
  - Tasks 7 and 14 use it.

- [ ] **Step 1: Add** the shadcn `select` and check it imports `@base-ui/react` (not Radix).
- [ ] **Step 2: Implement `Dropdown`** and replace every native `<select>`. Run `grep -rn "<select" apps/web/components apps/web/app`. Expected: no matches.
- [ ] **Step 3: Make the briefing toolbar wrap** (`flex-wrap`), so "Read in" and its dropdown are never clipped at 390 px.
- [ ] **Step 4: Run** `pnpm --filter @digestor/web test` and `pnpm typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Verify in the browser.** Open each dropdown once (upload, context check, Preview, Full briefing, Prepare subtitles, report dialog) at 1280 and 390 px. In the screenshots, the list is white and themed, and keyboard ↑/↓/Enter/Escape work. `errors.txt` is empty.
- [ ] **Step 6: Commit** `feat(web): one designed dropdown replaces native selects`.

### Task 4: Spinner on every waiting state (#6)

**Files:**
- Create: `apps/web/components/ui/spinner.tsx`
- Modify: every component that renders an `en.ts` value ending in "…" as a waiting state. The 25 keys are listed in the spec (#6). Find them with `grep -n '…"' apps/web/messages/en.ts`, skipping the placeholders and menu labels `youtubePlaceholder`, `names.change`, `ask.placeholder` and `preview.export`. Also cover the export statuses `queued`/`rendering` and the processing stages in `components/Processing.tsx`.

**Interfaces:**
- Produces: `<Spinner className? />`, which renders lucide `Loader2` with `aria-hidden`, `size-3.5` and `motion-safe:animate-spin`, and stays visible but still under reduced motion. Also `<Busy busy={boolean}>{text}</Busy>`, which renders the spinner **before** the text when `busy` and only the text otherwise. Later tasks use `Busy` for every new waiting state.

- [ ] **Step 1: Implement** `Spinner` and `Busy`.
- [ ] **Step 2: Use it** at every waiting label, both groups (backend jobs and button busy labels). The text always stays.
- [ ] **Step 3: Run** `pnpm typecheck`. Expected: clean.
- [ ] **Step 4: Verify in the browser.** Screenshot at least the Processing screen, the Ask "Thinking…" state, a Prepare "Saving…" state and an Export "Rendering…" row. Each shows a spinner next to the text. With `page.emulateMedia({ reducedMotion: "reduce" })`, the icon has no running animation (`getAnimations().length === 0`).
- [ ] **Step 5: Commit** `feat(web): spinner next to every waiting label`.

### Task 5: Skip replaces Neutral and Rejected; letter shortcuts go (#15, statuses)

**Files:**
- Modify (core):
  - `packages/core/src/personalTypes.ts`: `SelectionStatus = "approved" | "rejected"`.
  - `packages/core/src/schemas.ts`: `ClipStatusSchema = z.enum(["proposed", "approved", "rejected"])`.
- Create: the migration `packages/core/drizzle/0013_<name>.sql`, generated with `pnpm --filter @digestor/core exec drizzle-kit generate --custom --name selections_skip`, which also writes the journal entry. The body is `UPDATE "selections" SET "status" = 'rejected' WHERE "status" = 'neutral';`.
- Modify (web):
  - `app/api/moments/[id]/selection/route.ts` (enum `approved | rejected | null`; the error sentence becomes "Choose approved, skipped or null.");
  - `app/api/ask-actions/[id]/route.ts`;
  - `lib/askText.ts` (+ test);
  - `lib/statusQueue.ts` (+ test);
  - `lib/review.ts` (+ test);
  - `components/Ask/AskDrawer.tsx`;
  - `messages/en.ts`.
- Modify (worker): `apps/worker/src/agents/ask.ts` (+ `ask.test.ts`).
- Modify (docs): `CLAUDE.md` and `.claude/skills/digestor-ui/SKILL.md` (the Keyboard section and the statuses Approve / Neutral / Reject).

**Interfaces:**
- Produces:
  - `asSelectionStatus(v: unknown): SelectionStatus | null` in `lib/askText.ts`. It maps `"neutral"` and `"skipped"` → `"rejected"`, keeps `"approved"`/`"rejected"`, and returns null otherwise. It's used wherever stored Ask payloads or undo maps are read.
  - `lib/review.ts` keeps `isTyping`, `OWN_KEYS_SELECTOR`, `opensAsk`, `approvedMomentIds`, `asClipStatus` and `asSelection`. It **removes** `keyToAction`, `actionForKey`, `ACTION_STATUS`, `moveFocus`, `resolveFocus` and `ReviewAction`.
  - It adds `nextStatus(current: SelectionStatus | null, clicked: SelectionStatus): SelectionStatus | null`. Clicking the active status returns `null` (undecided); anything else returns `clicked`. Task 7 uses it.
  - Ask `set_selection` takes `status: "approved" | "skipped" | "proposed"`, where `skipped` is stored as `rejected` and `proposed` deletes the row. Its description reads "Mark moments approved or skipped (not a clip), or back to undecided (only when the user asks)…". Moment listings the model reads show `skipped` for `rejected`.

- [ ] **Step 1: Write the failing tests.**

```ts
// lib/review.test.ts
it("clicking the active status returns the moment to undecided", () => {
  expect(nextStatus("approved", "approved")).toBeNull();
  expect(nextStatus("rejected", "rejected")).toBeNull();
  expect(nextStatus(null, "rejected")).toBe("rejected");
  expect(nextStatus("approved", "rejected")).toBe("rejected");
});
// lib/askText.test.ts
it("reads legacy neutral and the model's skipped as rejected", () => {
  expect(asSelectionStatus("neutral")).toBe("rejected");
  expect(asSelectionStatus("skipped")).toBe("rejected");
  expect(asSelectionStatus("approved")).toBe("approved");
  expect(asSelectionStatus("maybe")).toBeNull();
});
it("parseBulkPayload accepts a stored neutral payload", () => {
  expect(parseBulkPayload({ momentIds: ["m1"], status: "neutral" })).toEqual({ momentIds: ["m1"], status: "rejected" });
});
```

  - In `ask.test.ts`: `set_selection` with `status: "skipped"` stores `rejected`, and the tool schema rejects `"neutral"`.
  - In `app/api/personal.test.ts`: `PUT /api/moments/:id/selection {status:"neutral"}` → 400, and `{status:"rejected"}` → 200.
  - Delete the tests of removed shortcut functions.
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test review askText personal`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.** Make the type changes, the migration, the route enums, the Ask tool mapping and the `askText` mapping. In `FullBriefing.tsx` and `MomentRow.tsx`, delete the global letter-key handler and the roving tabindex and focus code, and remove the Neutral button. **Keep these files compiling.** Task 7 replaces them, so add only the minimum: Skip = `rejected`. Drop the `briefing.keys*`, `neutral*` and `showNeutral` strings. The `bulkStatus` labels become `{ approved: "approved", rejected: "skipped" }`.
- [ ] **Step 4: Run** `pnpm db:migrate`, then `pnpm test` and `pnpm typecheck`. Check the disk first, then run `docker compose run --rm worker pnpm --filter @digestor/worker test ask`. Expected: all PASS. Then run `docker compose exec postgres psql -U postgres -d digestor -c "select status, count(*) from selections group by 1"`. Expected: no `neutral` row. (Check `.env` or `docker-compose.yml` for the DB user and name.)
- [ ] **Step 5: Update docs.** In `CLAUDE.md`, change the Ask drawer line and the statuses wording. In the `digestor-ui` skill, make the Keyboard section read "`/` opens Ask; no letter shortcuts", and change the statuses to Approve / Skip.
- [ ] **Step 6: Commit** `feat: Skip replaces Neutral and Rejected; letter shortcuts removed`.

### Task 6: The moment tree and level checkboxes (filter logic) (#15)

**Files:**
- Modify: `apps/web/lib/briefingFilters.ts`, `apps/web/lib/briefingFilters.test.ts`
- Create: `apps/web/lib/laneBars.ts`, `apps/web/lib/laneBars.test.ts`

**Interfaces:**
- Consumes: `SelectionStatus` (Task 5).
- Produces (in `briefingFilters.ts`, replacing the granularity floor):
  - `SHOW_FILTERS = ["open", "all", "approved", "skipped"] as const`.
  - `BriefingFilters { levels: Granularity[]; speaker; person; minRelevance; types; show }`.
  - `DEFAULT_FILTERS.levels = ["exchange", "passage", "punchline"]`, `show: "open"`.
  - `SHOW_HIDDEN_FILTERS = { ...DEFAULT_FILTERS, show: "approved" }`.
  - `filterMoments(moments, selections, f, topics?, ctx?, sticky?: ReadonlySet<string>): MomentView[]`:
    - A moment is **listed** when it passes the content filters (person, speaker, relevance, types) and the status filter, and its level is ticked **or** it is approved.
    - `sticky` ids skip the status filter only. These are rows decided during this visit.
    - Each listed official moment nests under its **nearest listed ancestor**. Walk `insideMomentId` up, with a visited set; only a coarser moment can be a parent.
    - With no listed ancestor, the moment is a root of its topic. Personal moments (`ask`, `user`, `find_more`) are always roots.
    - A moment is never hidden because of its parent. The order stays as today (topic, then start).
  - `MomentView` is unchanged.
  - `hiddenApprovedCount` and `groupByTopic` are unchanged.
  - `toSearchParams` writes `lv=exchange,punchline` only when not all three levels are ticked, and drops `g`.
  - `fromSearchParams` reads `lv`; an unknown or empty `lv` means all levels. It ignores the legacy `g`, and an unknown `show` (`neutral`, `rejected`) falls back to `open`.
- Produces (`laneBars.ts`): `laneBars(views: MomentView[], topic: { startMs: number; endMs: number }): LaneBar[]` with `LaneBar { id: string; level: Granularity; leftPct: number; widthPct: number; tone: Tone | null; approved: boolean }`.
  - `views` are flattened, children included: exactly the rows the tree shows.
  - Positions are clamped to 0–100 inside the topic span, with a minimum width of 0.8%.
  - `tone` is `HIGHLIGHT_TYPES[m.highlights[0].type].tone`, or null with no highlight.

- [ ] **Step 1: Write the failing tests.** Rewrite the granularity tests in `briefingFilters.test.ts`, using the existing helpers there:

```ts
it("a passage with no exchange above it is a root, not hidden", ...)              // 12-of-31 Bundestag case
it("a punchline whose passage level is unticked attaches to its exchange", ...)   // levels: exchange+punchline
it("a punchline with no shown ancestor is a topic root", ...)
it("an approved moment at an unticked level stays listed and keeps its children", ...)
it("sticky ids stay listed under show=open after being skipped", ...)
it("self, missing, finer-parent and cyclic insideMomentId never hide or duplicate a moment", () => {
  // a.inside=a; b.inside="nope"; c(exchange).inside=d(punchline); e.inside=f, f.inside=e
  const ids = flatten(filterMoments(moments, {}, DEFAULT_FILTERS)).map((v) => v.moment.id).sort();
  expect(ids).toEqual(moments.map((m) => m.id).sort());
});
it("fromSearchParams: legacy g and show=neutral fall back to defaults", () => {
  expect(fromSearchParams(new URLSearchParams("g=passage&show=neutral"))).toEqual(DEFAULT_FILTERS);
});
it("levels round-trip through lv and default levels are omitted", () => {
  const f = { ...DEFAULT_FILTERS, levels: ["exchange", "punchline"] as Granularity[] };
  expect(toSearchParams(f)).toBe("lv=exchange,punchline");
  expect(fromSearchParams(new URLSearchParams("lv=exchange,punchline"))).toEqual(f);
  expect(toSearchParams(DEFAULT_FILTERS)).toBe("");
});
it("show=skipped lists rejected moments only", ...)
```

  In `laneBars.test.ts`: test positions against a 60 s topic (a moment at 15–30 s → `leftPct 25`, `widthPct 25`), the tone from the first highlight, `null` with no highlights, and clamping for a moment that overhangs the topic end.
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test briefingFilters laneBars`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update `Controls.tsx` and `FullBriefing.tsx` only as far as needed to compile. The old level select becomes the three level checkboxes in Task 7; until then, pass `DEFAULT_FILTERS.levels`.
- [ ] **Step 4: Run** the same tests plus `pnpm typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(web): moment tree with level checkboxes; no moment hidden by its parent`.

### Task 7: One Briefing page at `/s/[id]` (#15, page)

**Files:**
- Create:
  - `apps/web/lib/briefingPage.ts`: the server loader, merging what `app/s/[id]/page.tsx` `PreviewScreen` and `app/s/[id]/briefing/page.tsx` load.
  - `apps/web/lib/useBriefingTranslation.ts`: the Read-in state and polling, moved out of `BriefingDoc`.
  - `apps/web/components/Briefing/Briefing.tsx`: the page client component.
  - `components/Briefing/SummaryCard.tsx`.
  - `components/Briefing/DocActions.tsx`: Copy text, Export…, Share link, Read in.
  - `components/Briefing/TopicCard.tsx`.
  - `components/Briefing/SomethingOff.tsx`: ReanalyzeDialog and ReportProblem, moved from `Preview.tsx`.
- Modify:
  - `app/s/[id]/page.tsx` (`ready` → `<Briefing>`);
  - `components/AppBar.tsx` (`STEPS` without `"Preview"`);
  - `components/Briefing/MomentRow.tsx` (rewrite);
  - `components/Briefing/Controls.tsx` (level checkboxes, the status filter All / Open / Approved / Skipped);
  - `next.config.ts` (redirect);
  - `components/Prepare/PrepareList.tsx`, `components/ExportList.tsx` (links to `/s/${id}`);
  - `messages/en.ts`;
  - `lib/preview.ts` (`PreviewSection.rows` is no longer needed; keep `buildSections` for summary and key quote);
  - `CLAUDE.md` (the flow and stepper); the UI concept spec gets a dated note at the top of its §5.
- Delete:
  - `app/s/[id]/briefing/page.tsx`;
  - `components/Briefing/FullBriefing.tsx`;
  - `components/Preview/Preview.tsx`;
  - `components/Preview/BriefingDoc.tsx`.
  - Move `Timeline.tsx` and `TopHighlights.tsx` to `components/Briefing/`.
  - Remove the "+ Clip" strings (`preview.clip`, `clipLabel`, `clipBusy`) and `preview.looksRight`.

**Interfaces:**
- Consumes:
  - `filterMoments`, `laneBars`, `SHOW_FILTERS` and `DEFAULT_FILTERS` (Task 6);
  - `nextStatus`, `opensAsk` and `approvedMomentIds` (Task 5);
  - `MediaPlayer` (Task 1), `Dropdown` (Task 3), `Busy` (Task 4).
- Produces:
  - `loadBriefingPage(db: Db, session: Session): Promise<BriefingProps | null>`, where `BriefingProps` is the union of today's `PreviewProps` and `FullBriefingProps` without duplicates.
  - `<Briefing {...BriefingProps} key={analysis.id} />`.
  - The redirect in `next.config.ts` is `{ source: "/s/:id/briefing", destination: "/s/:id", permanent: false }`. Next keeps the query string.

- [ ] **Step 1: Write the failing tests.** `lib/preview.test.ts` keeps `buildSections` summary and key-quote coverage and drops the assertions on `rows`. Add a `lib/briefingPage` unit test only if the loader has logic worth pinning beyond the two loaders it merges (it should not).
- [ ] **Step 2: Build the page.** The layout follows spec #15 and the mockup `.superpowers/brainstorm/75281-1793877941/content/briefing-tree-3.html`. Rebuild from the description, not the mockup code.
  - **Header:** title, the meta line from Preview (duration · speakers/named → Who's who · language · profile · "Analysis v<n>" with the note), Who's who, and Ask (`/`).
  - **Notices:** running re-analysis, failed re-run, names changed, video removed, sensitive, earlier selections, and the `ContextBanner`.
  - **Summary card:** lead paragraph (translated when Read in is set), `Timeline` (pins scroll to the moment's row, else its topic card), `TopHighlights`, `DocActions`, and "Something's off".
  - **Filter row:** `Controls`, with levels as three checkboxes with counts, Focus, minimum relevance, types, status, and Find more for a focused person. Below it, "N shown" and "Reset filters".
  - **One `TopicCard` per topic group:**
    - a numbered title with its time range;
    - the topic summary and key quote collapsed to the first sentence with "More" (`aria-expanded`);
    - a `LaneGraph` slot (empty until Task 8);
    - the tree as a `<ul>`, children nested with connector lines (`border-l` plus a short horizontal tick) and an "N inside" count on the parent.
  - **Row:**
    - ▶ Play / ■ Stop with an inline `MediaPlayer`;
    - title (`lang`, `dir="auto"`), level tag, `hh:mm:ss · m:ss`, `HighlightChip`s, `PersonalMarker`, speakers (`SpeakerName`);
    - the "Why:" line, and a "Transcript" disclosure (collapsed) holding the excerpt;
    - **Approve / Skip** buttons. They have a fixed width (`min-w` sized for "Approved"), about 11.5 px text and 2×7 px padding. The labels toggle "Approve"→"Approved" and "Skip"→"Skipped". They use `aria-pressed`, keep the accessible name `"Approve: <title>"` / `"Skip: <title>"`, and are green when approved and stone when skipped. A click calls `nextStatus`.
    - Rows with status `rejected` are dimmed (`opacity-75`).
  - **Sticky set:** every id the user changes this visit is added to a `sticky` set and passed to `filterMoments`. The set clears when the filters change.
  - Keep the polite live region: "Approved: <title>", "Skipped: <title>", "Back to undecided: <title>".
  - **Sticky footer:** "N approved · M hidden by filters [Show hidden]" and **Prepare clips →** (the existing `queue.idle()` → `POST /clips` → push to Prepare flow, with `Busy`).
  - Find more and its polling move over unchanged. The "found at other levels" note is dropped, because all levels show by default. When some levels are unticked, the note names the unticked levels.
  - **Removed:** "+ Clip", "Looks right → Full briefing", and every `/briefing` link.
- [ ] **Step 3: Update the stepper and the strings.** `STEPS` = Upload, Processing, Context, Briefing, Prepare, Export. Remove `appBar.step.Preview`. The ready screen uses `current="Briefing"`. Prepare's back link points to `/s/${id}` with the label "Briefing" (its look comes in Task 9).
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: PASS, clean. Then `grep -rn "Full briefing\|/briefing\b\|FullBriefing\|BriefingDoc\|looksRight" apps/web --include=*.ts --include=*.tsx`. Expected: no matches outside `next.config.ts`.
- [ ] **Step 5: Verify in the browser** on the Bundestag session (`dac9d3c2…` or the seeded ready session) at 1280 and 390 px:
  - `/s/<id>/briefing?show=all` redirects to `/s/<id>?show=all`, and the status filter shows "All".
  - The default view lists all 58 Bundestag moments (7 + 31 + 20, give or take the personal ones). The 12 passages without an exchange are roots under their topic.
  - Untick Passages. Punchlines attach to their exchange, or become roots.
  - Approve a row, click it again, and it is back to undecided. Skip a row under Open: it stays in place, dimmed. Change a filter and it goes.
  - The Approve and Skip buttons don't change width (`getBoundingClientRect().width` is equal before and after).
  - Pressing `a`, `n`, `r`, `e` or ↓ does nothing; `/` opens Ask.
  - Prepare clips → opens Prepare with the approved clips.
  - `errors.txt` is empty and there's no horizontal overflow at 390 px.
- [ ] **Step 6: Commit** `feat(web): one Briefing page (summary on top, moment tree underneath)`.

### Task 8: Three-lane graph per topic (#15, lanes)

**Files:**
- Create: `apps/web/components/Briefing/LaneGraph.tsx`
- Modify: `components/Briefing/TopicCard.tsx`, `messages/en.ts`

**Interfaces:**
- Consumes: `laneBars` (Task 6); `TONE_DOT` from `components/HighlightChip.tsx` for bar colours (grey `bg-stone-300` when `tone` is null).
- Produces: `<LaneGraph bars={LaneBar[]} hoveredId={string | null} onHover={(id: string | null) => void} onPick={(id: string) => void} />`.
  - Three rows labelled Exchange / Passage / Punchline (`t("granularity.*")`).
  - Approved bars get a `ring-2 ring-green-600` outline.
  - Hovering a bar sets `hoveredId`, which highlights its tree row; hovering a row highlights its bar.
  - Clicking a bar scrolls to `#moment-<id>` (smooth unless reduced motion) and focuses its Play button.
  - It is `hidden sm:block` (hidden below 640 px).
  - Each bar is a `<button>` with `aria-label` = "<level>: <title>, <hh:mm:ss>".

- [ ] **Step 1: Implement** `LaneGraph`, fed from the same `views` the tree renders (`laneBars(flatten(group.views), topic)`), so a bar always has its row.
- [ ] **Step 2: Run** `pnpm typecheck`. Expected: clean.
- [ ] **Step 3: Verify in the browser.**
  - At 1280 px, the bars of the heated moments are red (the `heated` tone).
  - Hovering a bar highlights its row.
  - Clicking a bar scrolls to its row.
  - After unticking Punchlines, the punchline lane is empty and the graph matches the tree.
  - At 390 px the graph is hidden.
- [ ] **Step 4: Commit** `feat(web): three-lane graph per topic`.

**Wave 1 ends here.** Run `pnpm test`, `pnpm typecheck` and, after the disk check, `pnpm test:worker`. Then report a status table to the owner (run `date` first) before wave 2.

---

## Wave 2: Prepare and Export

### Task 9: Back link becomes a ghost button (#3)

**Files:**
- Create: `apps/web/components/BackLink.tsx`
- Modify: `components/Prepare/PrepareList.tsx`, `components/ExportList.tsx`, `messages/en.ts`

**Interfaces:**
- Produces: `<BackLink href={string} label={string} />`, a Next `Link`:
  - a lucide `ChevronLeft` (`size-4`, `aria-hidden`) plus the label;
  - `text-sm` ink colour (`text-foreground`);
  - `rounded-full px-2.5 py-1 -ml-2.5`;
  - `hover:bg-muted` and `focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-brand`.

- [ ] **Step 1: Implement** it and use it on Prepare (`href=/s/<id>`, label "Briefing") and Export (`href=/s/<id>/prepare`, label "Prepare clips"). Rename the strings to `prepare.backToBriefing: "Briefing"` and `exportScreen.backToPrepare: "Prepare clips"`, with no "←". Delete `briefing.backToPreview` if any use survived Task 7.
- [ ] **Step 2: Run** `pnpm typecheck`, then screenshot both headers with the link focused by Tab.
- [ ] **Step 3: Commit** `feat(web): back links as ghost buttons`.

### Task 10: Trim strip readout (#4)

**Files:**
- Modify: `apps/web/lib/trim.ts`, `apps/web/lib/trim.test.ts`, `apps/web/components/Prepare/TrimStrip.tsx`, `messages/en.ts`

**Interfaces:**
- Produces:
  - `timeMarks(viewStart: number, viewEnd: number, stepMs = 10_000): number[]`: every multiple of `stepMs` strictly inside the window, ascending.
  - `formatTenths(ms: number): string`, as `m:ss.s` (e.g. `75_250` → `"1:15.3"`), for "Clip length".

- [ ] **Step 1: Write the failing tests.**

```ts
it("timeMarks: round 10 s positions strictly inside the window", () => {
  expect(timeMarks(62_000, 125_000)).toEqual([70_000, 80_000, 90_000, 100_000, 110_000, 120_000]);
  expect(timeMarks(60_000, 120_000)).toEqual([70_000, 80_000, 90_000, 100_000, 110_000]);
});
it("formatTenths", () => {
  expect(formatTenths(75_250)).toBe("1:15.3");
  expect(formatTenths(9_000)).toBe("0:09.0");
});
```

- [ ] **Step 2: Run** `pnpm --filter @digestor/web test trim`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and the strip:
  - **Hover guide:** a 1 px guide line follows the pointer, with `formatTimestamp(ms, { tenths: true })` above the strip. It's hidden on pointer leave and `pointer-events-none`.
  - **Handle labels:** `text-xs` (12 px), shown on hover, keyboard focus and drag.
  - **Clip length:** "Clip length m:ss.s" (`prepare.clipLengthLive: "Clip length {length}"`) under the strip while dragging.
  - **Time marks:** under the strip, replacing the two end labels.
  - **Touch:** labels show while dragging.
- [ ] **Step 4: Run** the trim tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Verify in the browser.** A Playwright hover over the strip shows the time label. While dragging a handle (`mouse.down`/`move`), the screenshot shows both labels and "Clip length". The marks are at :10 positions.
- [ ] **Step 6: Commit** `feat(web): trim strip shows where you are in time`.

### Task 11: Alt saves a free cut (#5)

**Files:**
- Modify (core): `packages/core/src/snap.ts` and `snap.test.ts`.
- Modify (web):
  - `app/api/clips/[id]/route.ts` and `app/api/clips/[id]/undo/route.ts`;
  - `lib/personal.ts` (helper);
  - `lib/prepareApi.ts`, `lib/prepareData.ts` (+ test);
  - `components/Prepare/TrimStrip.tsx`, `PrepareList.tsx`, `ChecksPanel.tsx`;
  - `messages/en.ts`;
  - `app/api/prepare.test.ts` or `personal.test.ts` (route tests).
- Modify (docs): `CLAUDE.md` (the two snap rules), the `digestor-ui` skill (the Trim line in Keyboard), and the UI concept spec (the Prepare trim paragraph).

**Interfaces:**
- Produces (core `snap.ts`):
  - `cutsMidSentence(b: Boundary[], r: Range): boolean`. It is true when the start or the end lies inside **no** boundary gap, where a gap is `[afterWordEndMs, beforeWordStartMs]` and "inside" includes the gap's ends. Everything `snapRange` returns lies in a gap.
  - `snapEdges(b: Boundary[], current: Range, requested: Range, toleranceMs = 100): Range`.
    - An edge within `toleranceMs` of its current value is unchanged and kept **verbatim**. A changed edge takes the matching edge of `snapRange(b, requested)`.
    - If the result has `startMs >= endMs`, it returns `snapRange(b, requested)`.
  - `freeEdges(current: Range, requested: Range, toleranceMs = 100): Range`: the same unchanged-edge rule, with no snapping.
- Produces (web):
  - `PATCH /api/clips/[id]` body `{ start: string; end: string; free?: true }`. With `free`, it validates `0 ≤ start < end ≤ duration` and applies `freeEdges`. Without it, it applies `snapEdges`. Extend keeps today's behaviour (it snaps the end it sets).
  - Every `PATCH` and undo response is the clip plus `midSentence: boolean`, computed by `midSentenceFor(db, session, range): Promise<boolean>` in `lib/personal.ts` (transcript → `findBoundaries` → `cutsMidSentence`). It is false when there's no transcript.
  - `ClipView.midSentence: boolean` (`toClipView` reads `midSentence ?? false`). The Prepare page computes it on the server for the first render.
  - `ClipChange` adds `{ start: string; end: string; free?: true }`. `TrimStrip`'s `onCommit` becomes `(r: Range, opts: { free: boolean }) => Promise<unknown>`.

- [ ] **Step 1: Write the failing tests.**

```ts
// snap.test.ts (b from a small word list: gaps [1000,1400], [5000,5600], [9000,9300])
it("cutsMidSentence is false for snapped cuts and true for an edge in a sentence", () => {
  expect(cutsMidSentence(b, snapRange(b, { startMs: 1200, endMs: 9100 }))).toBe(false);
  expect(cutsMidSentence(b, { startMs: 3000, endMs: 9100 })).toBe(true);
});
it("snapEdges keeps an untouched edge verbatim, within tenths precision", () => {
  expect(snapEdges(b, { startMs: 3000, endMs: 9150 }, { startMs: 3000, endMs: 5200 })).toEqual({ startMs: 3000, endMs: snapRange(b, { startMs: 3000, endMs: 5200 }).endMs });
  expect(snapEdges(b, { startMs: 3045, endMs: 9150 }, { startMs: 3000, endMs: 5200 }).startMs).toBe(3045); // "00:00:03.0" for 3045
});
it("freeEdges takes changed edges as given", () => {
  expect(freeEdges({ startMs: 1250, endMs: 9150 }, { startMs: 1250, endMs: 7777 })).toEqual({ startMs: 1250, endMs: 7777 });
});
```

  Route tests:
  - `PATCH {start,end,free:true}` stores the exact ms and returns `midSentence: true`.
  - A later normal `PATCH` that changes only the end keeps the free start verbatim.
  - Undo restores the previous bounds verbatim.
  - `free` with `end > duration` → 400 with `RANGE_ERROR`.
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test snap` and `pnpm --filter @digestor/web test prepare personal`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **TrimStrip:** remember `e.altKey` at pointer-up, and for Alt+arrow keys, and pass `{ free }`. The typed fields always send `free: false`.
  - **ChecksPanel:** when `clip.midSentence`, show `WarningNote` with the spec copy, `prepare.midSentence: "Cuts mid-sentence: the clip starts or ends while someone is still speaking."`.
  - **Acknowledgement:** confirm the checklist still requires `warningsAck`. The checks are null for a cut that differs from its moment, see `packages/core/src/checklist.ts`. Make the acknowledgement label read `prepare.warningsAckMid: "I've read these warnings, including the mid-sentence cut"` when `midSentence`.
  - **Help text:** update `trimHelp` to "Handles snap to sentence boundaries. Hold Alt (Option) while dragging, or with the arrow keys, to save an exact position instead; that cut is marked as mid-sentence."
- [ ] **Step 4: Check subtitles.** In the worker container, run `docker compose run --rm worker pnpm --filter @digestor/worker test subtitles`, and add a case to `subtitles.test.ts`: `buildCues` for a range starting mid-sentence includes no word that ends before `startMs` or starts after `endMs`. Fix `buildCues` only if that fails.
- [ ] **Step 5: Run** core, web and worker tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Update docs** with the spec sentence: *AI and normal cuts snap to sentence boundaries (sentence ends, or a pause inside a very long sentence); an Alt cut is saved as is and carries a mid-sentence warning.*
- [ ] **Step 7: Verify in the browser.**
  1. Alt-drag the start into a sentence and release. The saved time equals the released time (tenths), and the mid-sentence warning shows.
  2. Drag the end normally. The start doesn't move.
  3. Undo. Both are back.
- [ ] **Step 8: Commit** `feat: Alt saves a free cut, marked mid-sentence`.

### Task 12: Plain words for subtitle videos and an honest Export (#8, #10)

**Files:**
- Modify: `apps/web/lib/exportRows.ts` (+ test), `components/ExportList.tsx`, `components/Prepare/SubtitlesPanel.tsx`, `messages/en.ts`

**Interfaces:**
- Produces:
  - `ExportLanguageRow.burn` becomes `{ status: RenderStatus; url: string | null; state: "none" | "notMade" | "outOfDate" | "making" | "done" | "failed" }`. The mapping:
    - `stale` + no `burnKey` → `notMade`;
    - `stale` + `burnKey` → `outOfDate`;
    - `queued`/`rendering` → `making`;
    - `done` + key → `done`;
    - `failed` → `failed`;
    - `none` → `none`.
  - `toMake(rows: ExportRow[]): number` counts the languages whose state is `notMade` or `outOfDate`, or `failed` with an approved track.
  - `inFlight(rows)` is unchanged and drives the banner.

- [ ] **Step 1: Write the failing tests** in `exportRows.test.ts`:
  - a stale track without a key → `state: "notMade"`, `url: null`;
  - with a key → `"outOfDate"`;
  - `toMake` over two clips with one `notMade` and one `outOfDate` → 2.
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test exportRows`. Expected: FAIL.
- [ ] **Step 3: Update the copy** per spec #8. There is no "burn" in any value:
  - `prepare.burnIn: "Put these subtitles in the video (always visible)"`;
  - `prepare.burnInLabel: "Put the {language} subtitles in the video (always visible)"`;
  - `burnRequested: "Made when you export."`;
  - `burnMaking: "The video with subtitles is being made."`;
  - `burnDone: "Video with subtitles ready."`;
  - `burnFailed: "The video with subtitles failed. Export again to retry."`;
  - `burnStale: "Video with subtitles is out of date"`;
  - `burnNeedsApproval: "Approve the lines to put them in the video."`;
  - `noTracks`, `editorDescription` and the checklist `subtitles` reworded the same way;
  - `exportScreen.burned: "MP4 with {language} subtitles"`;
  - `exportScreen.burnState.{notMade: "not made yet", outOfDate: "out of date", making: "being made…", failed: "failed. Export again to retry."}`;
  - the explainer `exportScreen.explainer` (spec text);
  - the footer `exportScreen.readyCountToMake: "{n} of {total} clips ready · {m} subtitle videos to make"` (and a singular form `…ToMakeOne`).

  Then check: `grep -in "burn" apps/web/messages/en.ts`. Only key names may match, not values.
- [ ] **Step 4: Update Export.**
  - Show the language line state through `burn.state`, with `Busy` for `making`.
  - Put the explainer under "Downloads".
  - Make the footer count use `toMake`.
  - Make the banner derived: show `exportScreen.started` while `inFlight(rows)`, and nothing otherwise. Remove the click-set banner state; error messages stay click-set.
  - Rename `startedBurns` to avoid "burn" ("Rendering has started, including the videos with subtitles. This page updates by itself.").
- [ ] **Step 5: Run** the tests and `pnpm typecheck`. Then in the browser: request a subtitle video on a clip that has a render. Export shows "MP4 with German subtitles: not made yet" and "1 subtitle video to make". After Export ready clips, it shows the spinner, then the download link, and the banner disappears by itself. Navigate away and back while nothing runs: no banner.
- [ ] **Step 6: Commit** `feat(web): plain words for subtitle videos; Export says what's really there`.

### Task 13: Subtitle style and position (core, migration, worker) (#11)

**Files:**
- Create: `packages/core/src/subtitleStyle.ts` (+ `subtitleStyle.test.ts`); export it from `packages/core/src/index.ts`.
- Create: the migration `packages/core/drizzle/0014_subtitle_style.sql`, via `pnpm --filter @digestor/core db:generate --name subtitle_style` after the schema change, then append the data statements.
- Modify:
  - `packages/core/src/db/schema.ts` (`clips.subtitleStyle text not null default 'yellow'`, `clips.subtitlePosition text not null default 'bottom'`);
  - `personalTypes.ts` (`Clip` fields; `ClipEventKind` adds `"style"`);
  - `db/personal.ts` (+ `personal.test.ts`);
  - `apps/worker/src/media/subtitles.ts` (+ test), `apps/worker/src/pipeline/render.ts`;
  - `apps/web/app/api/clips/[id]/route.ts` (+ route test), `lib/prepareApi.ts`, `lib/prepareData.ts`.

**Interfaces:**
- Produces (core, client-safe):
  - `SubtitleStyleSchema = z.enum(["yellow", "white", "white_box"])` and `SubtitlePositionSchema = z.enum(["bottom", "above_banner", "top"])`, with their types.
  - `SUBTITLE_GEOMETRY = { fontPct: 0.055, outlinePx1080: 4, shadowPx1080: 1, marginPct: { bottom: 0.06, above_banner: 0.22, top: 0.05 }, boxOpacity: 0.75 }`.
  - `SUBTITLE_STYLES: Record<SubtitleStyle, { color: string /* CSS hex */; bold: boolean; box: boolean }>`:
    - yellow: `#FFE600`, bold, no box;
    - white: `#FFFFFF`, bold, no box;
    - white_box: `#FFFFFF`, not bold, box.
  - `defaultSubtitlePosition(profile: ProfileId): SubtitlePosition`.
- Produces (core, server):
  - `insertClip` (and so `createClip` and `confirmClips`) sets the defaults when they aren't given. The style comes from the owner's most recently updated live clip, else `yellow`. The position comes from the session's profile.
  - `ClipPatch` adds `subtitleStyle` and `subtitlePosition`.
  - In `updateClip`, a style or position change records a `style` event (before/after `{subtitleStyle, subtitlePosition}`) and calls a new `staleBurnsIfDone(tx, clipId)`. That marks only `done` burns stale; the plain render doesn't change.
  - `undoLastEvent` reverts `style` like `format`, with `staleBurnsIfDone`.
  - `burnSignature(track, clip)` adds `subtitleStyle` and `subtitlePosition` to the hashed JSON. `clip`'s type gains both fields.
- Produces (worker): `buildAss(cues, video, look: { style: SubtitleStyle; position: SubtitlePosition })`, built from `SUBTITLE_GEOMETRY` and `SUBTITLE_STYLES`:
  - yellow/white: `Bold -1`, `BorderStyle 1`, `Outline round(4*h/1080)`, `Shadow round(1*h/1080)`, black outline;
  - white_box: `BorderStyle 3`, with the box colour black at alpha `&H40` in OutlineColour and BackColour;
  - `bottom` and `above_banner`: Alignment 2 with `MarginV = round(marginPct*h)`; `top`: Alignment 8.
  - Check the white_box render on a real frame in the container (libass draws the BorderStyle 3 box from OutlineColour), and compare it with `scratchpad/subs/` frames.
- Produces (web): the `PATCH` body variant `{ subtitleStyle?: SubtitleStyle; subtitlePosition?: SubtitlePosition }`, with at least one field. It is frozen with `VIDEO_REMOVED` like format. `ClipView` gains both fields.

- [ ] **Step 1: Write the failing tests.**

```ts
// subtitleStyle.test.ts
it("positions default by profile", () => {
  for (const p of ["parliament", "supreme_court", "trial", "un"] as const) expect(defaultSubtitlePosition(p)).toBe("above_banner");
  for (const p of ["interview", "electoral_debate", "other"] as const) expect(defaultSubtitlePosition(p)).toBe("bottom");
});
```

  `personal.test.ts` (DB):
  - a new clip in a `parliament` session gets `above_banner`, and `yellow` when the owner has no clips;
  - after the owner's latest clip is set to `white_box`, the next new clip is `white_box`;
  - a style change marks a `done` burn `stale` and leaves `renderStatus` `done`;
  - undo of a style change restores it;
  - **`finishTrackBurn` with a signature taken before a style change ends `stale`.**

  `subtitles.test.ts`:
  - `buildAss(…, {width:1920,height:1080}, {style:"yellow", position:"above_banner"})` contains `&H0000E6FF`, `,-1,` bold, `,1,4,1,2,` and `MarginV` 238;
  - `top` uses Alignment 8;
  - `white_box` uses BorderStyle 3.

  Route test: `PATCH {subtitleStyle:"neon"}` → 400, and `{subtitlePosition:"top"}` → 200.
- [ ] **Step 2: Run them.** Run `pnpm --filter @digestor/core test subtitleStyle personal` and the web route test. After the disk check, run `docker compose run --rm worker pnpm --filter @digestor/worker test subtitles`. Expected: FAIL.
- [ ] **Step 3: Implement.** Make the schema and generate the migration. Then append to the migration:

```sql
UPDATE "clips" c SET "subtitle_position" = 'above_banner' FROM "sessions" s
  WHERE s.id = c.session_id AND s.profile IN ('parliament','supreme_court','trial','un');
UPDATE "subtitle_tracks" SET "burn_status" = 'stale' WHERE "burn_status" = 'done';
```

  Next:
  - `render.ts` `burnTrack` passes `{ style: clip.subtitleStyle, position: clip.subtitlePosition }` to `buildAss`.
  - Add `style` to the web undo labels if they list event kinds.
- [ ] **Step 4: Run** `pnpm db:migrate`, all three test suites and `pnpm typecheck`. Expected: PASS. Then restart the worker (`docker compose restart worker`).
- [ ] **Step 5: Commit** `feat: subtitle style and position per clip; burns follow them`.

### Task 14: Style preview dialog in Prepare (#11, UI; #8 checkbox)

**Files:**
- Create: `apps/web/components/Prepare/SubtitleStyleDialog.tsx`, `apps/web/lib/subtitlePreview.ts` (+ test)
- Modify: `components/Prepare/SubtitlesPanel.tsx`, `PrepareList.tsx`, `app/layout.tsx` or the dialog (load Noto Sans via `next/font/google` for the preview only), `messages/en.ts`

**Interfaces:**
- Consumes: `SUBTITLE_GEOMETRY`, `SUBTITLE_STYLES`, the schemas (Task 13); `ConfirmDialog` primitives (Task 2); `patchClip` with `{subtitleStyle, subtitlePosition}`; `patchTrack {burn}`.
- Produces:
  - `previewCss(look: { style; position }, frameHeightPx: number): React.CSSProperties`. It gives the font size, colour, weight, `text-shadow`/`-webkit-text-stroke` border scaled from 1080p, box background `rgba(0,0,0,0.75)` for `white_box`, and `bottom`/`top` as a percentage of height. Same geometry as `buildAss`.
  - `<SubtitleStyleDialog open onOpenChange clip={ClipView} track={TrackView} sessionId hasVideo onUse={(look) => Promise<void>} />`.
    - **Frame:** a paused `<video preload="metadata" muted>` on the proxy at `#t=<first cue start>`, cropped like the clip: 16:9, or 9:16 through `object-fit: cover` and `object-position` from `cropOffset`. Audio-only sessions get the same dark background the render uses.
    - **Overlay:** the first cue's text in `previewCss`.
    - **Choices:** three style swatches (radio group: "Yellow", "White", "White on dark box") and three positions ("Bottom", "Above name banner", "Top"). Switching re-renders at once.
    - **Copy:** the line "The video is made when you export." with **Cancel** / **Use this style**.
- Wiring in `SubtitlesPanel`:
  - Ticking "Put these subtitles in the video (always visible)" opens the dialog. **Use this style** patches the clip look, if changed, then requests the burn. Cancel leaves the box unticked.
  - A ticked box shows a "Change look" link that opens the dialog. Use patches only the look; Cancel changes nothing.

- [ ] **Step 1: Write the failing test** in `subtitlePreview.test.ts`:
  - `previewCss({style:"yellow",position:"above_banner"}, 540)` has `color "#FFE600"`, `fontWeight 700`, `bottom "22%"`, and `fontSize` 29.7 px (0.055×540);
  - `white_box` has a `backgroundColor` with 0.75 alpha;
  - `top` sets `top "5%"` and no `bottom`.
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test subtitlePreview`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper, the dialog and the wiring. Add these strings to `en.ts`:
  - `prepare.styleTitle: "How should the subtitles look?"`
  - `styleYellow`, `styleWhite`, `styleWhiteBox`
  - `positionBottom`, `positionAboveBanner`, `positionTop`
  - `styleMadeAtExport`
  - `styleUse: "Use this style"`
  - `changeLook: "Change look"`
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Verify in the browser** on the Bundestag clip.
  - Ticking the box opens the dialog with a real frame, and the yellow text sits above the name banner.
  - Switching to Top moves it at once. Cancel leaves the box unticked.
  - Use, then Export, then Watch (Task 15): the made MP4 matches the preview closely.
  - Take a screenshot for the owner.
- [ ] **Step 6: Commit** `feat(web): choose and preview the subtitle look before export`.

### Task 15: Watch rendered videos on Export (#7)

**Files:**
- Modify: `apps/web/components/ExportList.tsx`, `apps/web/lib/exportRows.ts` (+ test), `messages/en.ts`

**Interfaces:**
- Consumes: `MediaPlayer` with `tracks` (Task 1); `ExportRow` (Task 12).
- Produces:
  - `ExportRow.watch: { mp4: string | null; tracks: { src: string; srcLang: string; label: string }[]; burned: { language: string; src: string }[] }`. The URLs come **without** `?download=1`, so they play inline.
  - Each `tracks[]` entry is a language's `vtt` URL (the language has text and isn't outdated).
  - `burned` lists every `done` subtitle video.

- [ ] **Step 1: Write the failing test.** `exportRows` returns `watch.mp4` = `/api/files/<s>/clips/<id>.mp4` (no query) when the render is done. A `de` track with text yields `{ src: "/api/files/<s>/clips/<id>.de.vtt", srcLang: "de" }`. A done burn appears in `burned`.
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test exportRows`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each rendered video row gets a "▶ Watch" toggle (`aria-expanded`, `aria-label` "Watch: <what>, <title>") next to its download.
  - One player is open on the page at a time. It sits under the row, with the CC tracks on the plain MP4.
  - Check that the files route serves `.vtt` inline with `Content-Type: text/vtt` when `download` is absent. If it doesn't, make it do so.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. In the browser, Watch plays the MP4 (a Range request gets 206), CC lists the languages, and opening another Watch closes the first.
- [ ] **Step 5: Commit** `feat(web): watch rendered videos on Export`.

### Task 16: "Your sessions" on the home page (#12)

**Files:**
- Modify: `packages/core/src/db/repo.ts` (+ `repo.test.ts`), `packages/core/src/server.ts` (export), `apps/web/app/page.tsx`, `messages/en.ts`
- Create: `apps/web/components/SessionList.tsx` (server component), `apps/web/lib/sessionList.ts` (+ test)

**Interfaces:**
- Produces:
  - `listSessionSummaries(db: Db, ownerId: string, limit = 50): Promise<SessionSummary[]>` with `SessionSummary { id; title; language; profile: string | null; stage: Stage; error: string | null; videoRemoved: boolean; lastActivityAt: Date; renderedClips: number }`.
    - `lastActivityAt = greatest(sessions.updated_at, max(clips.updated_at))`; the list is newest first.
    - `renderedClips` counts the owner's live clips with `render_status = 'done'`.
  - `sessionStatus(s: Pick<SessionSummary, "stage" | "error">): { text: string; busy: boolean; tone: "normal" | "waiting" | "failed" }`:
    - `ready` → "Ready";
    - `awaiting_context` → "Waiting for you" (`waiting`);
    - `failed` → "Failed" (`failed`, friendly, no raw error);
    - any other stage → the Processing screen's stage label with `busy: true`. Reuse the labels in `lib/processingSteps.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `repo.test.ts`: three sessions, one with a later clip update, come out in activity order; `renderedClips` counts only `done` live clips.
  - `sessionList.test.ts`: `awaiting_context` → "Waiting for you"; `transcribing` → busy; `failed` → "Failed".
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test repo` and `pnpm --filter @digestor/web test sessionList`. Expected: FAIL.
- [ ] **Step 3: Implement.** The list goes under the upload form, under the heading "Your sessions" (`home.sessions`).
  - **Row:** title (`lang`, `dir="auto"`), profile, the status with `Busy` while processing, the date (`Intl.DateTimeFormat`), "N clips", and "Video removed" when it has been.
  - The whole row links to `/s/<id>`.
  - With no sessions, nothing is shown.
  - The home page reads the DB, so it needs `<Suspense>` under Cache Components; see `nextjs16-gotchas`.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. In the browser at 1280 and 390 px, the list shows and a click opens the session.
- [ ] **Step 5: Commit** `feat(web): your sessions on the home page`.

**Wave 2 ends here.**
1. Check the disk, then run the full suite: `pnpm test`, `pnpm typecheck` and `pnpm test:worker`.
2. Do a `digestor-run` pass over the whole flow (Upload → Briefing → Prepare → Export) at 1280 and 390 px.
3. Ask for a whole-branch review (`superpowers:requesting-code-review`), then a status table for the owner.
4. **Don't merge to `main`** until the owner says so.

---

## Calls made while planning (flag at handover)

1. Two migrations, not one:
   - `0013_selections_skip` (wave 1) maps `neutral` → `rejected`;
   - `0014_subtitle_style` (wave 2) adds the style columns and data. The spec named the style migration 0013.
2. `/s/[id]/briefing` → `/s/[id]` is a `next.config.ts` redirect (which keeps the query), not a page.
3. The selection API keeps storing `approved` | `rejected`. "Skip" is a UI word, and so is `skipped`, for Ask's tool and the URL filter.
4. The changed-edge rule uses a 100 ms tolerance (the precision of `hh:mm:ss.s`), so an untouched edge sent back as text is kept verbatim.
5. `midSentence` is computed on the server and returned with every clip PATCH and undo response. The transcript never reaches the client.
6. A style or position change is its own undoable clip event (`style`). It marks only the subtitle videos stale, not the plain MP4.
7. One `MediaPlayer` component carries the pause-when-hidden hook for all inline players; the hidden sample players use the hook directly.
8. The "found at other levels" note in Find more goes, since all levels show by default. It names the unticked levels when some are off.
