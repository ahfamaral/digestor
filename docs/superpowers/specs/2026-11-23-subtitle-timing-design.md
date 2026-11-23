# Subtitle timing, editor overlay and a yellow box style

Date: 2026-11-23. Status: approved 2026-11-23 ("banana") and built the same day. Round 3 (line editing, word-time repair) below, also built that day.

## Why

While reviewing a translation, the owner saw some subtitle lines appear a bit late. Only some lines were late, not the whole track. The likely cause: a line too long for two rows is split across several screens, and `trackToCues` (core `subtitleText.ts`) shares the line's time out by **character count**, not by when the words are spoken. It hits vertical clips hardest (24-character rows). In the owner's tracks, 14 of 39 English lines in 9:16 clips are long enough to split. The editor also can't show the subtitle on the video, and its line highlight moves only on `timeupdate` (about 4 times a second), so the owner can't judge timing there.

## Goals

1. A split line's pieces change at a real spoken-word time, preferring a pause (option A, "follow the speech").
2. The subtitle editor (`TrackEditor`) shows the subtitle over the video, exactly as the final video will (same split, style, position), including unsaved edits, updated every frame while playing.
3. A new subtitle style, "Yellow on dark box".
4. Word-by-word highlighting, as an option: in the spoken language, each word lights up as it is said.

## Non-goals (for now)

Per-line time nudges, deleting, adding, splitting or merging lines, shifting the whole track, and a draggable timeline. These come later if 1 and 2 aren't enough.

## Anti-goals

- Losing the owner's text edits (the backfill and the new build must keep them).
- The editor preview disagreeing with the burned video or the SRT/VTT.

## Approaches considered

- **A. Follow the speech (picked by the owner).** Store each original word's time and length on its line when a track is built. When a line must be split, cut at the word boundary closest to the same point in the text, preferring a pause. Exact for original-language tracks, and follows the speaker's rhythm for translations. Works after a format change. Existing tracks get the word times from their transcript (no API cost, edits kept).
- **B. Build shorter lines from the start.** Fit each original line to the clip's format so splits rarely happen. Translations that come out longer still split by characters, a later 16:9 → 9:16 change brings the problem back, and fixing existing tracks means a rebuild that wipes edits. Not picked.

## Design

**Word times on each line.** `TrackCue` gains an optional `words: { startMs, endMs, chars }[]` (clip-relative times, as the cue's own, plus the character length of each spoken word, in order). `prepareTrack` (worker `pipeline/tracks.ts`) fills it from the words `buildCues` grouped into that line. Text edits keep it (`editTrackCues` already copies the cue). Old tracks without `words` keep today's character rule.

**Splitting (`trackToCues`).** For each split point, take its fraction of the shown text (as today) and find the matching position in the original's words by the same fraction of their characters. Cut at the nearest word boundary, preferring one with a pause (gap ≥ 150 ms) within a word or two. The next piece starts at the next word's start, and the previous piece ends there (no flicker gap). Each piece keeps a minimum on-screen time when the line allows it. As built, a line that is still the spoken words is instead cut *between words* so the shortest screen lasts as long as possible, and every screen starts exactly on its first word. A real burn showed that shifting the time for the minimum left the last word ("the") alone, and "before" never lit up. The same function serves the SRT/VTT download, the burn (ASS) and the editor preview, so all three agree.

**Existing tracks.** A one-off script, run in the worker container (`apps/worker/scripts/backfill-track-words.ts`, idempotent), rebuilds `buildCues` from the transcript for each `ready` track's built range. It attaches `words` only to lines whose start and end match the stored line, and touches nothing else (text, approval and burn status unchanged). Outdated tracks are skipped.

**Burned videos.** A burned video made before this change keeps its old timing. Because the burn signature includes the cues, adding `words` must not mark existing burns stale on its own. Only a re-burn uses the new split. (The builder confirms how `burnSignature` reads cues.)

**Editor overlay (`TrackEditor`).** On a video session, draw the current on-screen cue over the player with `previewCss` and the clip's `subtitleStyle` / `subtitlePosition`. The text comes from `trackToCues` on the cues with the editor's current texts. While playing, a `requestAnimationFrame` loop reads `currentTime` and drives both the overlay and the highlighted line; paused, it updates on seek. Audio-only and removed videos show no overlay. The overlay is `aria-hidden` (the line list is the accessible view).

**New style.** `yellow_box` in `SubtitleStyleSchema` and `SUBTITLE_STYLES`: `#FFE600`, regular weight, box at `boxOpacity` like `white_box`. The label is "Yellow on dark box", next to "White on dark box". The column is plain text, so there is no migration. Covered: the style picker, its preview, the editor overlay and the burn (ASS).

**Word highlighting (owner asked, my recommendation taken: originals only).**
- **Where it applies.** It works only for a track in the session's spoken language whose line text still matches the original words. Translations stay plain: their words don't line up with the spoken ones, so a highlight would sometimes light a word before or after it is said, which a journalist can't show as the speech. A line whose text was edited so its words no longer match the original also shows without highlighting (whole line, today's look).
- **Look.** Words already spoken and the word being spoken show in the style's own colour; words still to come show in the same colour at 55% (`upcomingOpacity`). The line fills in as it is said, with one colour, not a colour per word. As built, the progressive fill reads as the flow and doesn't flicker word to word.
- **The option.** A per-clip on/off option in the subtitle style dialog, "Highlight words as they're spoken", off by default. It is stored on the clip next to style and position (a new boolean column, so a migration) and is part of `burnSignature`, so changing it marks a burned video stale.
- **Burn.** ASS karaoke timing (`\k` per word) in `buildAss`, using the line's `words`.
- **Editor overlay and style preview.** The same effect, drawn per frame.
- **Downloads.** SRT/VTT stay plain: SRT can't carry it, and few players show VTT word timing.

## Left to the builder

The exact pause threshold and minimum piece time (start from 150 ms and about 0.8 s), and the search window around the target word. Tests: core split cases (same language exact, translation, pause preference, no `words` fallback, CJK), the worker build attaching `words`, the backfill matching rule, the style in `buildAss` and `previewCss`. Verify with `digestor-run` on a 9:16 clip with a long translated line, at 1280 px and 390 px.

## Round 3: line editing and word-time repair

Approved 2026-11-23 ("banana"), after the owner found lines still off in the Spanish track of a session with a crowd chant and asked where to delete or add lines.

**Why.** The cause was the transcript, not the split. AssemblyAI stretched "nossa" (2.5 s) and "luta" (1.6 s), then crushed "pelo fim da escala 6 por 1!" into 0.47 s (7 words), so lines built on those times sit early or late. No split rule fixes wrong input times, so the journalist needs to set times by hand, and the worst cases should be repaired before they see them.

**Line editing (`TrackEditor`).**
- Each line shows its start and end ("0:25.6 – 0:28.0"). A "Timing" toggle opens two fields (m:ss.s, as `parseTimestamp` reads them, clip time) with "Use player time" buttons. In a field, the up and down arrows move the time by 0.1 s (Shift: 1 s).
- "Delete line" removes a line (not when it is the only one). "Add line after" puts a new line in the gap after it, or, with no room, takes the second half of that line. "Add line at <time>" under the player does the same at the playhead (inside a line, it cuts that line there). A new line has no original ("Added by you") and empty text, so it counts as missing until typed.
- Nothing is stored until Save, which sends the whole list (`PATCH /api/tracks/[id] { lines, base }`). The server checks it (`checkTrackLines`, core): 1–2,000 lines, each at least 0.2 s, inside the clip, in order, no overlap; problems are named per line, and the editor shows the same checks inline before saving. `base` is a fingerprint of the stored lines the editor started from (`trackLinesVersion`); a different one answers 409 ("These subtitles changed in another window. Close and open them again.").
- `applyTrackLines` (core) builds the stored lines: a line keeps its original, and keeps its word times only while its start and end are unchanged; a line with new times shows plain (no highlight) and splits by characters. Saving clears approval and marks a finished burned video out of date, like a text edit. The burn signature now includes the line times.
- Split and merge of lines, and dragging on a timeline, stay for later.

**Word-time repair (`repairWordTimes`, core, used by `buildCues`).** A run of 3 or more words each spoken at under 25 ms per character can't be real. If one of the 3 words before or after the run is stretched (at least 600 ms and 200 ms per character), the words from that stretched word through the run share the whole span by character count (+1 each). A crushed run with no stretched neighbour is left alone (nothing to borrow). It applies when a track is built or rebuilt; existing tracks get it on "Rebuild". The transcript itself is unchanged.
