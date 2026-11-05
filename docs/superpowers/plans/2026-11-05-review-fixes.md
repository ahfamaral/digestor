# Review fixes (9:16 subtitles, "Approval dismissed") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs the owner found on 2026-11-05: subtitles cropped in 9:16 clips, and clips whose moment is no longer approved showing in Prepare/Export with no hint.

**Architecture:** Subtitle wrap width and font size become per clip format in core `SUBTITLE_GEOMETRY`, read by the ASS burn (worker), the CSS preview (web) and SRT/VTT downloads. "Approval dismissed" is derived (no new column): a clip with a `momentId` whose owner selection is not `approved`. Ask's `propose_clip` approves its personal moment so Ask clips never carry the label.

**Tech Stack:** TypeScript strict ESM, Drizzle/Postgres, Next.js 16, vitest, libass via ffmpeg (worker container only).

**Spec:** agreed with the owner in conversation on 2026-11-05 (recorded in memory `digestor-build-status.md`, "NEXT"); this plan restates every decision.

## Global Constraints

- 16:9 output stays byte-identical: `MAX_CHARS` 42, `fontPct` 0.055 for 16:9.
- 9:16: wrap at 24 characters per line, font 4% of the frame height (77 px at 1920). If the real vertical render in Task 1 still overflows, lower to 22 characters; nothing else changes.
- ASS `WrapStyle: 0` (libass smart wrap) as a safety net for both formats.
- Never run ffmpeg on the host; renders run in the worker container.
- Core relative imports use `.ts`; worker uses `.js`.
- Label copy, exactly: badge `Approval dismissed`; tooltip/explanation `You skipped this moment or undid its approval on the Briefing. The clip stays, but Export ready clips leaves it out.`
- The label is neutral (stone tones, ⚠ icon `TriangleAlert` from lucide), not red/amber; follow the `digestor-ui` skill.
- Migrations are hand-written SQL following `packages/core/drizzle/0013_selections_skip.sql` (journal entry + snapshot copied from the previous one, since no schema changes).

## Review Focus

1. A clip whose `momentId` is null (older or free clips): never labelled — test in Task 2.
2. A clip whose moment belongs to an older analysis version and is still approved: not labelled (`listSelections` returns every version of the session) — test in Task 2.
3. A dismissed clip with a made MP4: downloads stay; only the "Export ready clips" request leaves it out — test in Task 2 (`exportableIds`).
4. A CJK track on a 9:16 clip wraps per character at 24 — test in Task 1.
5. Undoing an Ask clip's creation leaves no orphan approval on its Ask moment — test in Task 3.

---

### Task 1: Subtitle geometry per clip format

**Files:**
- Modify: `packages/core/src/subtitleStyle.ts` (geometry), `packages/core/src/subtitleText.ts` (wrap width param)
- Modify: `apps/worker/src/media/subtitles.ts` (`buildAss`), `apps/worker/src/pipeline/render.ts:75`
- Modify: `apps/web/lib/subtitlePreview.ts`, `apps/web/components/Prepare/SubtitleStyleDialog.tsx:86,139`, `apps/web/app/api/files/[id]/[...file]/route.ts:98`
- Create: `packages/core/drizzle/0015_vertical_subtitles.sql` (+ journal, snapshot)
- Test: `packages/core/src/subtitleText.test.ts`, `packages/core/src/subtitleStyle.test.ts`, `apps/worker/src/media/subtitles.test.ts`, `apps/web/lib/subtitlePreview.test.ts`

**Interfaces:**
- Produces: `SUBTITLE_GEOMETRY.fontPct: Record<ClipFormat, number>` (`{"16:9": 0.055, "9:16": 0.04}`), `SUBTITLE_GEOMETRY.maxChars: Record<ClipFormat, number>` (`{"16:9": 42, "9:16": 24}`); `wrapText(text: string, maxChars?: number): string[]`; `trackToCues(cues: TrackCue[], format?: ClipFormat): Cue[]` (default `"16:9"`); `buildAss(cues, video, look: { style; position; format: ClipFormat })`; `previewCss(look: SubtitleLook & { format: ClipFormat }, frameHeightPx)`.
- `MAX_CHARS` stays exported (= 42) for `layout`/`buildCues`, which build the stored 16:9-width cues.

- [ ] **Step 1: Failing tests**
  - core `trackToCues`: a 120-char Portuguese cue with `"9:16"` → every line ≤ 24 chars, ≤ 2 lines per cue, split into several cues covering the same start/end; the same cue with no format argument gives exactly today's output (snapshot the current result before changing code). CJK text `"这是一个很长的中文字幕".repeat(5)` with `"9:16"` → lines ≤ 24 chars.
  - core `subtitleStyle`: `SUBTITLE_GEOMETRY.fontPct["9:16"] === 0.04`, `maxChars["16:9"] === 42`.
  - worker `buildAss`: 1080×1920 with `format: "9:16"` → `Fontsize` 77 in the Style line and `WrapStyle: 0`; 1920×1080 with `"16:9"` → Fontsize 59 (unchanged).
  - web `previewCss`: `format: "9:16"`, frame 400 → `fontSize` 16; `"16:9"`, frame 400 → 22.
- [ ] **Step 2: Run them, see them fail** — `pnpm --filter @digestor/core test subtitle`, `pnpm --filter @digestor/web test subtitlePreview`, `docker compose run --rm worker pnpm --filter @digestor/worker test subtitles`.
- [ ] **Step 3: Implement.** `wrap` takes the limit as a parameter; `trackToCues` uses `SUBTITLE_GEOMETRY.maxChars[format]`; `buildAss` reads `fontPct[look.format]` and writes `WrapStyle: 0`; `burnTrack` passes `trackToCues(track.cues, clip.format)` and `format: clip.format`; the SRT/VTT route passes `clip.format`; the style dialog passes `clip.format` to both `trackToCues` and `previewCss`. Update the `trackToCues` doc comment (no more "42").
- [ ] **Step 4: Migration 0015**: `UPDATE "subtitle_tracks" t SET "burn_status" = 'stale' FROM "clips" c WHERE c.id = t.clip_id AND c.format = '9:16' AND t.burn_status = 'done';` (existing vertical burns were cropped). Run `pnpm db:migrate`.
- [ ] **Step 5: Tests pass** (the three commands above), `pnpm typecheck`.
- [ ] **Step 6: Real vertical frame.** In the worker container, write a small script in the scratchpad (not committed) that builds the ASS for the Bundestag clip `1a104075…` (9:16, pt track) with `buildAss(trackToCues(cues, "9:16"), {width:1080,height:1920}, …)` and renders one frame per first 3 cues with ffmpeg + `subtitles=` filter onto that clip's source at its crop. Look at the PNGs: every line fully inside the frame with margin. If any overflows, set `maxChars["9:16"]` to 22, update the tests, repeat. Report the frames' paths.
- [ ] **Step 7: Commit** `fix: 9:16 subtitles wrap at 24 characters and a smaller font`.

### Task 2: "Approval dismissed" in Prepare and Export

**Files:**
- Modify: `apps/web/lib/prepareData.ts` (helper), `apps/web/app/s/[id]/prepare/page.tsx`, `apps/web/components/Prepare/PrepareList.tsx`, `apps/web/app/s/[id]/export/page.tsx`, `apps/web/components/ExportList.tsx`, `apps/web/messages/en.ts`
- Test: `apps/web/lib/prepareData.test.ts`, `apps/web/lib/exportRows.test.ts`

**Interfaces:**
- Produces: `approvalDismissed(momentId: string | null, selections: Record<string, SelectionStatus>): boolean` in `prepareData.ts` — true iff `momentId !== null && selections[momentId] !== "approved"`. `PrepareClipData.dismissed: boolean`, `ExportClipData.dismissed: boolean`. `exportableIds(clips: { id: string; dismissed: boolean; failing: string[] }[]): string[]` in `exportRows.ts` — whatever ExportList currently sends for "Export ready clips", minus dismissed clips.
- Messages: `prepare.approvalDismissed`, `prepare.approvalDismissedHint` (copy in Global Constraints); Export reuses them.

- [ ] **Step 1: Failing tests**: `approvalDismissed(null, {})` false; `("m1", {m1: "approved"})` false; `("m1", {m1: "rejected"})` true; `("m1", {})` true (undecided). `exportableIds` drops a dismissed clip with no failing items and keeps a non-dismissed ready one.
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test prepareData exportRows` → FAIL.
- [ ] **Step 3: Implement.** Both pages load `listSelections(db, OWNER_ID, id)` once (all analysis versions) and set `dismissed` per clip. PrepareList shows the badge next to the clip title with the hint (tooltip + `aria-describedby`); trim, subtitles, style, render all unchanged. ExportList shows the same badge on the clip's row, keeps every download/Watch link, and builds the "Export ready clips" request with `exportableIds`; the count shown with the button (if any) uses the same list. No server-side change to `POST /api/sessions/[id]/export` (it renders the ids it is sent).
- [ ] **Step 4: Run** the focused tests, then `pnpm test` and `pnpm typecheck` → green.
- [ ] **Step 5: See it** with the `digestor-run` skill on Bundestag `b3e26a69-9471-44ee-87d8-dee5d239e299`: Prepare and Export show the badge on b3dca385, 74780dfa, 13e1cdf5 only; screenshot both at desktop and phone width; no console errors.
- [ ] **Step 6: Commit** `feat(web): "Approval dismissed" on clips whose moment is no longer approved`.

### Task 3: Ask clips approve their moment

**Files:**
- Modify: `apps/worker/src/agents/ask.ts:438` (propose_clip), `packages/core/src/db/personal.ts` (`undoLastEvent`)
- Create: `packages/core/drizzle/0016_ask_clip_approval.sql` (+ journal, snapshot)
- Test: `apps/worker/src/agents/ask.test.ts`, `packages/core/src/db/personal.test.ts`

**Interfaces:**
- Consumes: `setSelection(db, ownerId, momentId, "approved")`, `createPersonalMoment` (origin `"ask"`).
- Produces: after `propose_clip`, the new personal moment has an `approved` selection. `undoLastEvent` on a `create` event of a clip whose moment is a personal moment with `origin = 'ask'` also deletes that moment's selection, in the same transaction.

- [ ] **Step 1: Failing tests**: worker — after a `propose_clip` call, `listSelections` has the new moment as `approved`. core — create an Ask personal moment + approved selection + clip, `undoLastEvent` the creation → clip deleted and no selection row for that moment; the same for a user (`origin: "user"`) or official moment keeps its selection.
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test personal` and `docker compose run --rm worker pnpm --filter @digestor/worker test ask` → FAIL.
- [ ] **Step 3: Implement** (selection set right after `createClip`; in `undoLastEvent`, look up the moment in the same `tx`).
- [ ] **Step 4: Migration 0016** backfills: insert `approved` selections (`owner_id = clips.owner_id`) for personal moments with `origin = 'ask'` that have a live clip and no selection row (`ON CONFLICT DO NOTHING`). Run `pnpm db:migrate`.
- [ ] **Step 5: Run** `pnpm test`, `pnpm test:worker`, `pnpm typecheck` → green.
- [ ] **Step 6: Commit** `fix: Ask clips approve their moment, so they never show "Approval dismissed"`.
