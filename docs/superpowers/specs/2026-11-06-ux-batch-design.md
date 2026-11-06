# UX batch (2026-11-06) — design

Source: a whole-app UI/UX review on fresh seeded sessions (screenshots in the session scratchpad, `uxreview/`), the home-page final review, and the owner's answers on 2026-11-06. The owner asked to do **everything** now. Builds on branch `home-page` (Sessions page, `/new`, clickable stepper).

## Owner decisions (verbatim intent)

- **Prepare "For all clips":** changing a shared setting updates only clips still on the shared value; a clip changed by hand keeps its value and is marked "(differs)".
- **Approved moments are never hidden** by any Briefing filter (fix the code; the rule in `digestor-ui` stands).
- **No re-check after a trim.** No "Check this cut" button and no automatic re-check.
- **Export "Download all"** offers three choices: (1) videos with subtitles burned in, (2) videos plus subtitle files (SRT/VTT), (3) videos only, no subtitles. Later: think about reducing the project's data size (not in this batch).

## Bugs

1. "No name" for every voice shows "Names changed after this analysis was written… Re-analyse". A "No name" choice is not a name change: no banner.
2. A highlight-type filter hides approved moments (decision above).
3. Ask said no moment is labelled Heated while the Briefing shows a Heated chip: find why Ask's data/tools miss highlight labels and fix it.
4. Prepare's "Export ready clips" is enabled with 0 clips ready (Export's own button is disabled then): same rule on both.
5. Unknown `/s/<id>` shows Next's default 404 (HTTP 200 in dev): a branded not-found page with the app bar and a way home.
6. Briefing timeline: the first pin is clipped at the left edge and pins near 0:00 overlap.
7. Export "Fix in Prepare clips" links go to `/s/<id>/prepare` without an anchor: link to `#clip-<id>` and scroll there.
8. One-word subtitle cues ("showed.", "own."): check on a real session first; fix only if real.

## Improvements

1. **Prepare "For all clips" strip** at the top: credit line, format (16:9/9:16), subtitle languages; per-clip overrides marked "(differs)" (decision above). The credit typed once is remembered for the session's new clips.
2. **Prepare overview:** each card shows a status badge ("Ready to export" / "N to do"); ready cards can collapse to one line; a sticky clip index (number, time, status) links to `#clip-<id>`.
3. **Speaker names asked once:** Prepare and Export show one session-level banner ("2 voices aren't confirmed — blocks 4 clips [Confirm names]") instead of a line per clip and voice; on the Context check, the speaker question and the Who's who row become one place, Who's who above Continue.
4. **Ask:** the raw tool trace (tool names, UUIDs, `<transcript>` tags, text cut mid-word) folds into one "Sources (N)" disclosure in plain words; on desktop the drawer no longer blurs/blocks the Briefing.
5. **Contrast:** primary buttons reach WCAG AA (white on brand is 3.10:1; use a darker brand fill or ink text); upcoming stepper steps and done steps readable (tokens, not hex); disabled buttons look disabled (grey), not faded primaries.
6. **Export:** one status per card; to-dos written as actions; the SRT/VTT explanation once at the top; rendered clips first; "Download all" (decision above).
7. **Nested clips:** a clip inside another clip says "Inside clip N" under its heading in Prepare; on the Briefing, an approved moment inside another approved moment says "Inside an approved exchange/passage".
8. **Navigation:** a step indicator on phones ("Step 4 of 6 · Briefing"); `/reports` gets a back link and aligned layout; a step gets ✓ only when actually done (Prepare ✓ only with clips).
9. **Subtitle review with playback:** the review dialog has a player; clicking a line seeks to it; the original-language track shows one column, not two identical ones.

## Quick wins

Drop "→" from all copy (`en.ts`); "Export…" → "Download .md"; "Change..." → "Change…"; Undo shown only when there is something to undo; remove the ~70 px gap above the trim strip; poster frames for players (thumbnail); "Show: Open" → "Hide skipped"; one speaker separator (", "); Who's who durations as `m:ss`; hide the Alt-key help on touch devices; Approve/Skip ≥ 40 px tall on phones; Context check fields stack on phones; "Official record" on Upload behind a disclosure; merge the context banner with the header meta line; after rendering show "Rendered · download below".

## Home-page leftovers

No "Sessions" link on the login page; needs-you counts follow the current tab (and Body); a suggested-but-not-accepted or failed official record does not count as linked (Body = "Not linked"); remove dead `clipCountText`/`home.clipOne`/`home.clipMany`; group tracks by clip with a Map in `listClipPreviews`; say when more than 200 sessions exist.

## Merge-clips leftovers (cheap ones)

Keyboard focus moves to the surviving clip after a merge.

## Not in this batch

Data-size optimisation (owner: later). Re-checks after trims (owner: no). Parliament monitor, LangGraph switch, duplicate persons.

## Calls left to the builder (Claude's, listed for the owner)

Ask drawer on desktop: non-modal side panel. Status badge wording follows the Export checklist. Darker brand fill chosen by contrast check (≥ 4.5:1) keeping the orange family. "Download all" builds the zip on the server from stored files (no new renders); a clip without a burned version for choice (1) is listed as skipped in the dialog before download.
