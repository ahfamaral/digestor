# Subtitle timing, editor overlay, yellow box and word highlighting: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split long subtitle lines on real spoken-word times, show the subtitle over the video in the line editor, add a "Yellow on dark box" style, and an optional word-by-word highlight for subtitles in the spoken language.

**Architecture:** Each stored line (`TrackCue`) carries its original words' times. The one function that turns stored lines into on-screen cues (`trackToCues`, core) uses them for the splits and, when asked, for per-word highlight times. The SRT/VTT download, the burn (ASS) and both web previews all call it, so they agree.

**Tech Stack:** TypeScript, zod, Drizzle (Postgres), Next.js 16 client components, libass karaoke tags via ffmpeg (worker).

**Spec:** `docs/superpowers/specs/2026-11-23-subtitle-timing-design.md`

## Global Constraints

- Core relative imports use `.ts`; the worker uses `.js`.
- Copy goes in `apps/web/messages/en.ts` via `t()`. Style label: "Yellow on dark box". Option label: "Highlight words as they're spoken".
- Pause threshold 150 ms; minimum piece time 800 ms (when the line is long enough); search window ±2 words.
- The highlight is off by default. It applies only when a line's text equals its original (whitespace-normalised) and the original's whitespace tokens match the stored words one to one (count and character length). Otherwise the line shows plain.
- Look: progressive karaoke. Words already spoken and the current word show at full colour; words still to come show at `SUBTITLE_GEOMETRY.upcomingOpacity` = 0.55. My call: a progressive fill reads as the flow of the speech and doesn't flicker word to word; this refines the spec's "rest of the line dimmer".
- `burnSignature` includes `subtitleHighlight` only when true, so existing signatures don't change.
- Never touch `~/Desktop/data`. The backfill only adds `words`: it changes no text, approval or burn status.

## Review Focus

1. An edited line in the spoken language (text ≠ original) must still split on a pause and show plain, never highlight the wrong words. Test in Task 1.
2. Old tracks without `words` must render exactly as before (the character rule). Test in Task 1.
3. A translation with highlight on shows plain lines. Test in Task 1.
4. CJK lines (no spaces between words) must not crash, and show plain. Test in Task 1.
5. A one-line cue (no split) with highlight gives ASS `\k` durations that sum to the cue's length (no drift from rounding). Test in Task 4.

---

### Task 1: Speech-timed splits and highlight times in `trackToCues` (core)

**Files:** Modify `packages/core/src/personalTypes.ts` (`TrackCue`), `packages/core/src/subtitleText.ts`, `packages/core/src/subtitleStyle.ts` (`upcomingOpacity`). Test: `packages/core/src/subtitleText.test.ts`.

**Interfaces:**
- Produces: `TrackCue.words?: CueWord[]`, where `type CueWord = { startMs: number; endMs: number; chars: number }` (clip-relative; `chars` = code points of the word's text).
- Produces: `Cue.karaoke?: number[]`: the clip-relative start time of each whitespace token of `lines.join(" ")`, in order.
- Produces: `trackToCues(cues: TrackCue[], format?: ClipFormat, opts?: { highlight?: boolean }): Cue[]`.
- Produces: `cueWordsMatch(cue: TrackCue): boolean` (text equals original and tokens match words).

- [ ] Write failing tests:
  - `splits a same-language line at the next piece's first word start`: words with known times, 9:16, the second cue's `startMs` equals that word's `startMs` and the first cue's `endMs` equals it too.
  - `prefers a pause within two words of the character target`: a 400 ms gap two words after the target, and the split lands there.
  - `keeps the character rule without words`: the same input with no `words` gives today's output.
  - `edited line splits on speech times but has no karaoke`.
  - `translation has no karaoke even with highlight on`.
  - `karaoke gives one start per token when highlight is on and words match`.
  - `CJK line with words shows plain`: no throw, no `karaoke`.
  - `keeps pieces at least 800 ms when the line allows`.
- [ ] Run `pnpm --filter @digestor/core test subtitleText` and see the new ones fail.
- [ ] Implement:
  - Wrap and chunk the lines as today.
  - If `cueWordsMatch` and each chunk's tokens line up with the words, the boundary is the next chunk's first word start.
  - Otherwise, when `words` exist, map the chunk's character fraction onto the words' cumulative characters, take the closest word start, and replace it with the closest boundary within ±2 words whose gap from the previous word is ≥ 150 ms.
  - Clamp so each piece is ≥ 800 ms when `span ≥ 800 × pieces`.
  - With no `words`, use today's character rule.
  - `karaoke` is set only when `opts.highlight` and the words match.
- [ ] Run the tests until they pass, then commit at the end of the work, when the owner asks.

### Task 2: Store word times when a track is built (worker)

**Files:** Modify `apps/worker/src/media/subtitles.ts` (`buildCues` also returns each cue's words), `apps/worker/src/pipeline/tracks.ts`. Test: `apps/worker/src/media/subtitles.test.ts`, plus the existing tracks test.

**Interfaces:**
- Produces: `buildCues(words, range): (Cue & { words: CueWord[] })[]`, where `words` holds each word's clip-relative times and `[...text].length`.
- Consumes: `CueWord` from Task 1.

- [ ] Failing test: `buildCues returns each cue's words with clip-relative times`, and `prepareTrack stores words on every cue`.
- [ ] Implement, then run `docker compose run --rm worker pnpm --filter @digestor/worker test subtitles tracks`.

### Task 3: Backfill word times on existing tracks

**Files:**
- Create: `apps/worker/scripts/backfill-track-words.ts`.
- Pure helper `attachWords(stored: TrackCue[], built: { startMs; endMs; words }[]): { cues: TrackCue[]; attached: number }` in `packages/core/src/subtitleText.ts`.
- Test: `packages/core/src/subtitleText.test.ts`.

- [ ] Failing tests:
  - `attachWords adds words only to lines whose start and end match`.
  - `attachWords leaves lines that already have words`.
- [ ] Implement the helper.
- [ ] Write the script:
  - For each `ready` track with built bounds, rebuild with `buildCues(transcript.words, { startMs: builtStartMs + 0, endMs })`, using the clip's absolute range from the track's `built_start_ms` / `built_end_ms`.
  - Call `attachWords`, then write only `cues`.
  - `--dry` prints the counts.
  - Skip outdated tracks.
  - It is idempotent.
- [ ] Run `--dry`, then a real run, in the worker container. Report the counts.

### Task 4: "Yellow on dark box" style and the highlight in the burn

**Files:**
- Modify: `packages/core/src/subtitleStyle.ts`, `apps/worker/src/media/subtitles.ts` (`buildAss`), `apps/worker/src/pipeline/render.ts`, `apps/web/messages/en.ts`, `apps/web/components/Prepare/SubtitleStyleDialog.tsx`.
- Test: `packages/core/src/subtitleStyle.test.ts`, `apps/worker/src/media/subtitles.test.ts`.

**Interfaces:**
- Produces: `SubtitleStyle` gains `"yellow_box"`, with `SUBTITLE_STYLES.yellow_box = { color: "#FFE600", bold: false, box: true }`.
- Produces: `buildAss(cues, video, look)`. When a cue has `karaoke`:
  - PrimaryColour is the full colour.
  - SecondaryColour is the same colour at `upcomingOpacity`.
  - The text is `{\kNN}` per token, with a leading `{\kNN}` for the time before the first word.
  - Durations come from cumulative centiseconds, so the sum equals the cue's length.

- [ ] Failing tests:
  - `yellow_box draws a box with yellow text` (ASS style line: BorderStyle 3, primary `&H0000E6FF`).
  - `karaoke cue writes \k tags summing to the cue length`.
  - `cue without karaoke has no \k`.
- [ ] Implement. `render.ts` calls `trackToCues(track.cues, clip.format, { highlight: clip.subtitleHighlight })` (field from Task 5; do Task 5's schema step first if built in order).
- [ ] Add the label, and add the style to the dialog's `STYLES` after "White on dark box".

### Task 5: The per-clip highlight option

**Files:**
- Create: `packages/core/drizzle/0037_subtitle_highlight.sql` and its journal entry (via `pnpm --filter @digestor/core exec drizzle-kit generate` or by hand, matching meta).
- Modify:
  - `packages/core/src/db/schema.ts`: `subtitleHighlight: boolean("subtitle_highlight").notNull().default(false)`.
  - `packages/core/src/db/personal.ts`:
    - `ClipPatch` picks `subtitleHighlight`.
    - `updateClip` counts it as a style change, so the event's before/after and `staleBurnsIfDone` include it.
    - `insertClip` copies the last style clip's `subtitleHighlight`.
    - `burnSignature` includes it when true.
  - `apps/web/app/api/clips/[id]/route.ts`: the look schema gets `subtitleHighlight: z.boolean().optional()` in the refine.
  - `apps/web/lib/prepareApi.ts`, `apps/web/lib/prepareData.ts` (`ClipView.subtitleHighlight`).
  - `apps/web/lib/subtitlePreview.ts`: `SubtitleLook.highlight`.
  - `SubtitlesPanel.tsx` (`saveLook` compares and sends it), `SubtitleStyleDialog.tsx`.
  - `en.ts`: the `prepare.highlightWords` label and the `prepare.highlightWordsHint` hint, "Only for subtitles in the spoken language; translations stay plain."
- Test: `packages/core/src/db/personal.test.ts`, `apps/web/app/api/personal.test.ts`.

- [ ] Failing tests:
  - `updateClip subtitleHighlight logs a style event and stales a done burn`.
  - `undo restores subtitleHighlight`.
  - `burnSignature unchanged when highlight is off`.
  - `PATCH accepts subtitleHighlight`.
- [ ] Write the migration and run `pnpm db:migrate`.
- [ ] Implement.
- [ ] The dialog gets a checkbox under the choices. Its preview shows the first line with its first third of tokens at full colour and the rest dimmed, when the line matches; otherwise plain.

### Task 6: Subtitle over the video in the line editor

**Files:**
- Modify: `apps/web/lib/subtitlePreview.ts`, `apps/web/components/Prepare/TrackEditor.tsx`.
- Create: `apps/web/components/Prepare/SubtitleOverlay.tsx` (renders one `Cue` with `previewCss` and, when `karaoke`, token spans whose colour is full or at `upcomingOpacity` by `nowMs`; `aria-hidden`; Noto Sans like the dialog).
- Test: `apps/web/lib/subtitlePreview.test.ts`.

**Interfaces:**
- Produces: `editorCues(track: TrackView, texts: string[], format, highlight): Cue[]`, which merges the edited texts into the stored lines, then calls `trackToCues`.
- Produces: `spokenTokens(cue: Cue, nowMs: number): number`, the count of tokens already started.

- [ ] Failing tests:
  - `editorCues uses unsaved texts`.
  - `spokenTokens counts tokens whose start ≤ now`.
- [ ] Implement:
  - `TrackEditor` puts the frame `relative`, measures its height (ResizeObserver, as the dialog does), and draws `SubtitleOverlay` for `cueAt(editorCues, position)`.
  - While playing, a `requestAnimationFrame` loop reads `currentTime` and sets the position and the active line. The existing `onTime` stays for when paused.
  - No overlay for audio-only or a removed video.
  - The active line in the list follows the stored line index: `cueAt(track.cues, pos)`, unchanged.

### Task 7: Verify

- [ ] `pnpm test`, `pnpm test:worker` (or the focused worker tests), `pnpm typecheck`, `pnpm --filter @digestor/web lint`. All pass.
- [ ] Use `digestor-run`: on a seeded `ready` demo session (never the owner's real sessions for edits), make a 9:16 clip with a long line and an English track. Open the editor, play, and take screenshots of the overlay with the highlight on and off at 1280 px and 390 px. Open the style dialog with "Yellow on dark box". Burn once in the worker and look at a frame. Delete the seeded data afterwards.
- [ ] Update `CLAUDE.md` (subtitles: word times, highlight option, migration 0037) and the `digestor-ui` skill's style list.
