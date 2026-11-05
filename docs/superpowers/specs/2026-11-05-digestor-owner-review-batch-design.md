# Owner review batch (2026-11-05): design

The owner reviewed the running app on 2026-11-05 and raised the topics below in one conversation. This document is the agreed description to plan and build from. Topic numbers follow that conversation; #9 and #13 were proposed and dropped.

Branch: **`plan-4-task-12`** (the owner chose to keep review fixes there, not on a branch from `main`). **Nothing is committed until the owner says so.** Follow the repo conventions in `CLAUDE.md` and the `digestor-ui` skill: copy in `apps/web/messages/en.ts`, tokens rather than hex values, inline friendly errors, a11y names, and verification with the `digestor-run` skill at 1280 px and 390 px.

## Why

The owner hit five kinds of friction while using the app as a journalist would:

- **One-click actions with no way back.** "No name" in Who's who removed a record-confirmed name at once. It was restored by hand by superseding the human row. "+ Clip" jumped to Prepare while a video was playing.
- **Media that keeps playing after you leave.** Next 16 with Cache Components keeps a page you left inside React `<Activity mode="hidden">` (`display: none`), not unmounted. A `<video>` inside it keeps playing. This was reproduced with Playwright: the Preview video was still playing, inside a hidden element, after "+ Clip" opened Prepare.
- **The trim strip leaves you lost in time.** The only times shown are the window's two ends, plus a 10 px handle label that appears only while dragging. Alt/Option "free" positions snap back on release, which reads as broken.
- **Export confuses people.** "Burn in" is jargon. A burn that was requested but never made shows "Burned-in MP4: out of date", because `requestTrackBurn` stores a request as `burnStatus = 'stale'`. A "Rendering has started" banner from an earlier export survives navigation. There's no way to watch a render before downloading it.
- **Burned subtitles are hard to read.** They're thin white text with a 2 px outline at the bottom, drawn over the broadcaster's name banner (seen on the Bundestag clip `dac9d3c2`). The owner compared real frames and chose **bold yellow with a black border, raised above the banner**.
- Waiting states are static "…" text, and there's no list of sessions to switch between.

## Goals

1. Every one-click action that changes data or leaves the page asks first. In this batch that covers "+ Clip" and "No name"; the owner will add more places later, so the dialog is shared.
2. No media keeps playing on a page the user can't see.
3. The trim strip always tells you where you are in time, and Alt saves exactly what you chose.
4. Export says plainly what exists, what's missing and what each file is for, and lets you watch before downloading.
5. Burned subtitles are readable over broadcast graphics, in a style the journalist picks and previews.
6. You can see and switch between all your sessions from the home page.

## Non-goals

- Object storage (B2/R2) or the VPS move: a separate job, planned for the week of 2026-11-09.
- Processing two videos in parallel (#13, dropped). Queues stay at one job at a time.
- An MP4 with a switchable subtitle track (#9, dropped).
- Detecting name banners automatically and a free colour picker.
- A DOM test setup for components, unless the builder proposes one (see "Left to the builder").

## Anti-goals (failure even if it "works")

- A confirmation that is skippable by accident: the action button focused by default, or Enter confirming.
- A burned style that is unreadable on some footage: free colours, or thin outlines.
- Removing the sentence-snap rule for anything other than a deliberate Alt cut: AI cuts, Extend, Ask `trim_clip` and normal drags must still snap.
- Copy that says "out of date" for something that was never made.

## The topics

### #1 Shared confirmation dialog (first used by "No name")

"+ Clip" is **removed** by #15. The owner found it useless without easy back-and-forth, so the dialog's first user is "No name". The "+ Clip" wording below is kept only as an example of the pattern.

- **New `components/ConfirmDialog.tsx`**, on the existing Base UI `components/ui/dialog.tsx`. Props: a title (a question), one line saying what will happen, the action label, an optional busy label, and `onConfirm` (async, with an inline `role="alert"` error on failure, keeping the dialog open).
- **Focus starts on Cancel.** Escape and a click outside both cancel. The action button is the brand button on the right, and Cancel is an outline button. Keyboard shortcuts on the page are already ignored while a dialog is open; keep that true.
- **Media:** when the dialog opens, it pauses every `<video>`/`<audio>` in the document that is playing, **Neither Cancel nor Confirm resumes them** (owner, 2026-11-05). The user presses Play again when they want to. (Generic on purpose: callers don't need to pass player refs.)
- **"+ Clip"** (`components/Preview/BriefingDoc.tsx`, `addClip`): title *"Make a clip of '<moment title>'?"*, line *"This approves the moment and opens Prepare clips, where you can trim it and add subtitles."*, action **"Make clip → Prepare"**. The current behaviour runs only after Confirm.
- **"No name"** (`components/Names/NamePopover.tsx`): for a named voice, title *"Remove the name from <voice label>?"*, line *"<Name> will be removed from <range or 'the whole video'>. You can name the voice again later."*, action **"No name"**. For a voice with no name (the `offerNoName` case), title *"Mark <voice label> as no name?"* with a matching line.
- Every new string goes in `en.ts`.

### #2 Players pause when their page is hidden

- **A hook** (e.g. `lib/usePauseWhenHidden.ts`) taking a media element ref: a `useLayoutEffect` whose cleanup pauses the element. React runs effect cleanups when an `<Activity>` boundary hides, so this fires on any navigation away (stepper, links, Back), not just "+ Clip". Coming back shows the player paused where it was.
- **Apply to all seven players:** `Preview/BriefingDoc.tsx` (video + audio), `Briefing/MomentRow.tsx` (video + audio), `Prepare/PrepareList.tsx` (video + audio), `Ask/AskDrawer.tsx` (video + audio), the hidden sample players in `Names/WhosWho.tsx` and `ContextCheck.tsx`, and the new Export player (#7).
- **Verify with the existing repro:** `/private/tmp/…/scratchpad/repro-bg-video.mjs` is throwaway, so rebuild it in the builder's scratch. Play on Preview, confirm "+ Clip", and on Prepare no media element may be `!paused`.

### #3 Back link becomes a ghost button

On Prepare → Briefing and Export → Prepare clips (Full briefing → Preview disappears with #15): a quiet button with a lucide `ChevronLeft` icon plus the page name, in ink colour (not muted grey), at `text-sm`, with a light pill background on hover and focus and a visible focus ring. Drop the typed "←" from `backToPreview`, `backToBriefing` and `backToPrepare`.

### #4 Trim strip readout (`components/Prepare/TrimStrip.tsx`)

- **Hover readout:** while the pointer is over the strip, a thin vertical guide line follows it, with the time at that point above the strip (`hh:mm:ss.s`).
- **Handle labels:** 12 px (`text-xs`), shown on hover, keyboard focus and drag (today only drag and focus). While dragging, a live **"Clip length m:ss.s"** line appears under the strip.
- **Time marks** under the strip at round 10 s positions across the window (the window is clip ± 30 s, so it's always 60 s or longer). They replace the two end labels.
- **Touch:** with no hover, labels show while dragging.
- `trimHelp` copy is updated for #5.

### #5 Alt saves a free cut

- **Mouse:** Alt/Option-drag saves exactly where the handle was released. **Keyboard:** Alt+←/→ already steps freely by 0.1 s, and now also saves that position.
- **API:** the `{ start, end }` variant of `PATCH /api/clips/[id]` gets an optional `free: true`. With it, the route validates the range (`0 ≤ start < end ≤ duration`) and skips `snapRange`.
- **Only changed edges are snapped (all requests):** the route snaps an edge only when its value differs from the clip's current one. An Alt-set edge therefore stays exactly where it is when the *other* edge is dragged normally or a time field for the other edge is typed. Moving the free edge itself without Alt snaps it again. Extend and Ask `trim_clip` snap the edges they set. Undo restores the previous bounds verbatim (it doesn't snap again).
- **Still snapped:** normal drags, the typed start/end fields (our call; the owner can override), Extend, AI cuts, Ask `trim_clip`, and everything else that goes through `snapRange`.
- **Warning:** add a check in core, e.g. `cutsMidSentence(boundaries, range)` in `snap.ts`. It's true when an edge sits on **no snap boundary at all**: not a sentence end and not one of the pause boundaries `findBoundaries` adds inside very long sentences. In practice, only Alt edges trigger it. Snapped AI and normal cuts never show it, including ones that landed on a pause. Prepare's checks panel shows *"⚠ Cuts mid-sentence: the clip starts or ends while someone is still speaking."* in the neutral warning style (`WarningNote`).
- **Checklist:** no new row is expected. A free cut always differs from its moment's bounds, so the clip already has no checks and needs the existing "acknowledge warnings" (`warningsAck`), which resets on any bounds change (R28). The builder confirms this holds and makes the acknowledgement copy mention the mid-sentence cut when it applies.
- **Subtitles:** confirm that track cues for a range that starts or ends mid-sentence are trimmed to the clip, with no words from outside it. Fix it if not.
- **Docs:** update the rule in `CLAUDE.md` ("Trim: the server always snaps…", "Every boundary (AI or human) goes through `snapRange`…"), the UI concept spec and the `digestor-ui` skill to say: *AI and normal cuts snap to sentence boundaries (sentence ends, or a pause inside a very long sentence); an Alt cut is saved as is and carries a mid-sentence warning.*

### #6 Spinner on every waiting state

- **New `components/ui/spinner.tsx`** (lucide `Loader2`, `animate-spin`, `aria-hidden`), shown **next to** the existing text, never instead of it. With `prefers-reduced-motion: reduce` it stays visible but doesn't spin.
- **Use it on every "…" waiting state, both groups:**
  - **Backend jobs:** render Queued…/Rendering…, burn-in queued…/burning in…, subtitle Preparing…, Translating the briefing…, Matching the official record…, Finding…, Checking…, Ask Thinking…, Processing stages.
  - **Button busy labels:** Saving…, Adding…, Starting…, Confirming…, Approving…, Sending…, Undoing…, Applying…, Opening Prepare clips…, Linking….
- The `en.ts` keys ending in "…" are the checklist (about 25).

### #7 Watch rendered videos on Export

- In Export's Downloads, each rendered video gets a **"▶ Watch"** toggle next to its download link. It opens an inline player under the row, the same pattern as Play on Preview, playing the **rendered file**:
  - the plain MP4, with that clip's subtitle tracks as `<track>` elements (VTT from the existing download routes), selectable through CC;
  - the "MP4 with <language> subtitles" (#8), if it exists.
- Only one player is open at a time, and it uses #2. The builder confirms the files route serves rendered clips with Range support (the proxy already does).

### #8 Plain words for burn-in

- **Prepare:** the "Burn in" control becomes a checkbox labelled **"Put these subtitles in the video (always visible)"**. Ticking it opens the style dialog (#11).
- **Export:** "Burned-in MP4" becomes **"MP4 with <language> subtitles"**.
- **One explainer line on Export:** *"Subtitle files (SRT/VTT) are for YouTube or a video editor. An MP4 with subtitles has the words in the picture, ready for social media."*
- Update every related string (`burnIn`, `burnInLabel`, `burnRequested`, `burnMaking`, `burnDone`, `burnFailed`, `burnStale`, `noTracks`, `editorDescription`, `exportScreen.burned`, `burnStatus.*`, checklist `subtitles`) so the word "burn" no longer appears in user-facing copy.

### #10 Export says what's really there

- **A requested version that was never made** (`burnStatus = 'stale'` with no `burn_key`) reads **"MP4 with <language> subtitles: not made yet"**. **"Out of date"** is kept for a version that exists (`burn_key` set) but no longer matches the cut, lines or style. This can be derived; a schema change is optional and is the builder's call.
- **The footer counts what's missing:** *"1 of 1 clips ready · 2 subtitle videos to make"*, so it's clear that **Export ready clips** makes them.
- **The "Rendering has started" banner** is derived from live statuses (any render or burn `queued`/`rendering`) rather than from a click in this page's state. It disappears when nothing is running, including after navigating away and back.

### #11 Subtitle style and position, with a preview dialog

- **Per clip, shared by all its languages:** a **style** — `yellow` (bold yellow `#FFE600`, about 4 px black border at 1080p, light shadow; the default), `white` (the same with white), `white_box` (regular white on a dark box at about 75% opacity) — and a **position** — `bottom`, `above_banner`, `top`. Stored on `clips` (new migration **0013**) and validated against exact values in core (`profiles.ts`/`schemas.ts` style).
- **Defaults for a new clip:**
  - **Style:** the style of the owner's most recently updated clip, or `yellow` when there is none.
  - **Position:** by session profile: `above_banner` for `parliament`, `supreme_court`, `trial` and `un`; `bottom` for `interview`, `electoral_debate` and `other`. (Owner: parliament, court and UN. Including `trial` as court is our call.)
- **One source of geometry:** put the style constants (font size 5.5% of height, border, margins: bottom 6%, above banner about 22%, top 5%) in core, so the worker's `buildAss` (`apps/worker/src/media/subtitles.ts`) and the web preview draw the same thing. The look of `above_banner` was checked on the Bundestag frame (`scratchpad/subs/6-yellow-border-raised.jpg`: ASS `BorderStyle 1`, `Outline 4`, `Shadow 1`, bold, `MarginV = 22% of height`).
- **The dialog** (built on #1's `ConfirmDialog` or the same primitives): it opens when the user ticks "Put these subtitles in the video" for a language, and from a **"Change look"** link next to a ticked checkbox.
  - **Content:** a real frame from the clip (the proxy paused at that language's first cue, with the clip's 16:9 / 9:16 crop applied), that cue's text drawn on top in the selected style and position (CSS, with Noto Sans loaded for the preview), a style choice (three swatches), a position choice (three options), the line *"The video is made when you export."*, and **Cancel** / **Use this style**.
  - Switching style or position updates the preview instantly.
  - Cancel leaves the checkbox unticked (or unchanged, for "Change look").
- **Changing style or position** marks this clip's made versions out of date (#10 wording), the same way a format change does today. The burn compare-and-set (`finishTrackBurn`, `burnSignature` in `packages/core/src/db/personal.ts`) must include style and position, so a burn made with an old style ends up `stale`.
- **Existing clips at migration 0013:** set style `yellow` and position from the session's profile (same defaults as new clips), and mark every `done` burn `stale` (it has a `burn_key`, so it reads "out of date"). Those files were made in the old thin-white bottom style and must not be shown as current. Only the owner's dev clips exist.
- **Audio-only sessions** (`hasVideo = false`): the dialog shows the cue over the same dark background the render uses for audio. The builder decides the details.
- **Fidelity:** the CSS preview is close, not exact. The exact check is #7 Watch on Export.

### #12 "Your sessions" on the home page

Under the upload form on `/`: a list of the owner's sessions, newest activity first. Each row shows:
- title (with `lang`/`dir="auto"`), profile, current stage in plain words (with the #6 spinner while processing, **"Waiting for you"** at `awaiting_context`, a friendly failed line), date, and the count of rendered clips;
- **"Video removed"** when retention has removed the video.

One click opens `/s/<id>`. It's a server component with data from a core repo function, and it fits the existing page frame. An empty state shows nothing extra.

### #14 One designed dropdown everywhere

The native `<select>` opens a macOS-drawn dark list that ignores the design. Add shadcn `Select` (Base UI, `pnpm --filter @digestor/web exec shadcn add select`), wrap it once as the app's dropdown (white list, `border-border`, rounded corners, Inter, ink-colour check mark, keyboard and screen-reader support from Base UI), and replace all 10 native selects:
- `Preview/BriefingDoc.tsx` ("Read in" language; it moves to the merged page in #15)
- `Preview/Preview.tsx`
- `Briefing/Controls.tsx` (×2)
- `UploadForm.tsx`
- `ContextCheck.tsx` (×2)
- `Names/RecordHouseSelect.tsx`
- `Prepare/SubtitlesPanel.tsx`
- `ReportProblem.tsx`

The briefing toolbar wraps rather than clipping: today the "Read in" label is cut off and the dropdown sits at the edge.

### #15 One Briefing page: summary on top, a moment tree underneath

**Why:** Preview and Full briefing "feel like the same page twice". Both play the same moment ranges from the same proxy. Preview lists only the best moment per highlight type per topic; Full briefing lists everything. Granularity today is a single-choice *level*, which hides moments silently. On the Bundestag analysis (7 exchanges, 31 passages, 20 punchlines), **12 of 31 passages sit outside any exchange and never show in the default Exchange view**.

**The agreed example:** mockup `.superpowers/brainstorm/75281-1793877941/content/briefing-tree-3.html`, built from the Bundestag data. The template is in the session scratchpad. The builder rebuilds from this description, not from the mockup's code.

- **One page at `/s/[id]`** once the session is `ready` (Processing and the context check stay where they are). `/s/[id]/briefing` redirects to it, keeping its query string. The stepper becomes **Upload › Processing › Context › Briefing › Prepare › Export**. Preview no longer exists as a step or a word in the UI.
- **Summary card at the top:** the lead paragraph, the session timeline (neutral topic bands with highlight pins), the top-highlight cards, and the document actions that lived on Preview: Copy text, Export…, Share link, Read in (#14 dropdown), "Something's off" (report / re-analyse), and the analysis version note. The per-topic summaries and key quotes from Preview's briefing document appear in each topic card's header area, collapsed to the first sentence with "More".
- **Moments underneath, one card per topic** (topic order, numbered, with time range):
  - **A three-lane graph:** rows Exchange / Passage / Punchline. Bars sit at the moment's position inside the topic span, red for heated (the highlight tone) and grey otherwise, with an approved outline. Hovering a bar highlights its row and the other way round. Clicking a bar scrolls to its row. Hidden below 640 px.
  - **A tree list:** each moment under its `insideMomentId` parent, drawn with connector lines and an "N inside" count on the parent. A moment with no parent, or whose parent level is unticked, attaches to its **nearest shown ancestor**, else to the topic. **No moment is ever hidden because of its parent or its level being off** (this replaces today's floor logic in `lib/briefingFilters.ts`).
  - **Row:** ▶ Play (inline player, as now, with #2), title (with `lang`), level tag, time · length, highlight chips (`HighlightChip`), speaker, and **Approve / Skip**.
- **Levels are checkboxes:** Exchanges · Passages · Punchlines, each with a count, all ticked by default. They are a URL filter like the others. The other filters (Focus on a person or voice, minimum relevance, highlight types, status) stay, as a filter row above the topics. The status filter offers All / Open / Approved / Skipped, with Open as the default.
- **Statuses: Approve / Skip.** Neutral and Rejected merge into **Skip** ("not a clip"). Buttons keep **one width** in both states: the label changes "Approve" → "Approved" (no ✓) and "Skip" → "Skipped", with colour from the approved/put-aside tokens, at the mockup's smaller size (about 11.5 px text, 2 × 7 px padding).
- **Decisions can be undone:** clicking the active "Approved" or "Skipped" again returns the moment to undecided (`proposed`), and `aria-pressed` reflects the state. Ask keeps `proposed` ("back to undecided, only when the user asks") alongside `approved` / `skipped`.
- **Skipping under the default Open filter:** a row skipped (or approved) in this visit **stays where it is, dimmed**, until the filters change or the page reloads. The tree doesn't jump, and the same button undoes it. Rows decided in earlier visits follow the filter normally.
- **Row evidence:** every AI-judged row keeps its **"Why:" line** (a design rule for AI judgments). The transcript excerpt sits behind a small "Transcript" disclosure on the row, collapsed by default, so 60 rows stay scannable.
- **Lane colours and set:** each bar takes the tone of its moment's first highlight type (`HIGHLIGHT_TYPES[*].tone`, as `HighlightChip` does), or neutral grey with no highlight, plus an approved outline. The graph shows **exactly the moments the tree shows** (same filtered set), so clicking a bar always finds its row.
- **Approved is never hidden** (R23 and the "N approved · M hidden by filters" footer rule stay). An approved moment at an unticked level is still listed as a normal tree node, and it can hold the shown moments inside it. Levels and content filters count towards "M hidden" only for approved moments they actually hide (content filters can; levels can't). The sticky bottom bar reads "N approved · M hidden by filters [Show hidden]" with **Prepare clips →** (the existing confirm flow).
- **Find more** (Plan 3) and the **Ask drawer** move to this page unchanged.
- **Removed:** "+ Clip" (Preview rows), the Preview route content, and the **letter shortcuts** A / N / R / E (the owner doesn't want them). **Kept:** `/` opens Ask (Escape closes it), Tab and Enter on buttons, and the in-control keys (trim handles, fields, name search).

## Constraints

- Next 16 rules from the `nextjs16-gotchas` skill (server/client boundary, Cache Components). Worker code and its tests run in the container. No ffmpeg on the host.
- Concurrency rules from `CLAUDE.md` still apply: style and position changes go through the same clip update path as format changes (events, stale marking, frozen clips answer 409 `VIDEO_REMOVED`).
- **New job-owned rows: none expected.** If one appears, it belongs in the sweep (R32).
- **Mac disk:** 19 GB free on 2026-11-05. Warn the owner below 16 GB. Docker builds need ≥ 15 GB free.

## Left to the builder

- Task order and grouping (suggested: #2 → #1 → #14 → #6 → #15 → #3 → #4 → #5 → #8 → #10 → #11 → #7 → #12). #15 is the largest; split it as needed (route merge and stepper, tree and level filter, statuses and shortcuts, lanes graph).
- Whether to add a jsdom + Testing Library setup for component tests. The `digestor-ui` skill says to propose it first; otherwise, logic goes in `lib/` with vitest, and the UI is verified with Playwright.
- Exact Tailwind classes, icon sizes, and tick spacing for short windows.
- Whether "not made yet" vs "out of date" is derived from `burn_key` or stored.
- Whether the free-cut flag is also recorded on the clip for display.

## Calls made without the owner (flag when handing over)

1. ~~The `E` shortcut stays without a dialog~~: superseded. #15 removes the letter shortcuts. Page-level ↑/↓ moment navigation goes with them; Tab moves between buttons and `/` still opens Ask.
2. ~~Cancel resumes paused media~~: owner decided that media stays paused after Cancel too.
3. Typed start/end fields keep snapping. Only Alt drags and Alt-arrows are free.
4. `trial` counts as "court" for the `above_banner` default.
5. The spinner goes next to the text, not instead of it.
6. Position defaults by profile, and only the style is carried over from the last clip.
7. The mid-sentence warning fires only for edges on no snap boundary (Alt cuts), not for snapped cuts that landed on a pause inside a long sentence.
8. The server snaps only the edges that changed, so a free edge survives edits to the other edge. Undo restores verbatim.
9. At the migration, existing clips get Yellow plus the profile position, and their already-made subtitle MP4s are marked "out of date".
10. **Skip is stored as the existing `rejected` value.** Existing `neutral` selections are migrated to `rejected`, and `neutral` leaves the selection schema, so no status value is added. Ask's `set_selection` tool accepts `approved` / `skipped` (mapped to `rejected`) and its prompt and tool description say so.
11. The per-topic summary and key quote from Preview's document live in each topic card's header, collapsed to the first sentence with "More".
12. `/s/[id]/briefing` redirects to `/s/[id]` (old links and shared URLs keep working).
13. Clicking an active Approved/Skipped returns the moment to undecided; Ask keeps "back to undecided".
14. Rows decided during this visit stay in place, dimmed, until the filters change or the page reloads.
15. Rows keep the "Why:" line; the transcript excerpt is collapsed behind "Transcript".
16. Lane bars use each moment's highlight tone (grey without one) and show exactly what the tree shows.
17. An approved moment at an unticked level stays listed and can still hold the moments inside it.
