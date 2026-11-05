# Digestor — UI Concept and Product Direction (Plan 2 onward)

**Date:** 2026-10-30
**Status:** Approved by owner 2026-10-30
**Builds on:** `2026-10-28-video-digestor-design.md` (the "v1 spec"). Plan 1 implemented the v1 core loop; that code is the baseline. Where this document and the v1 spec disagree, **this document wins**. The v1 spec still holds for anything this document doesn't mention, such as the pipeline internals, snapping and the context card.
**Mockups (inspiration, not pixel spec):**
- `docs/design/ui-concept-overview.html`: the agreed Preview screen.
- `docs/design/ui-concept-tracker.html`: the Tracker home proposal.
- `docs/design/walkthrough-mockups.html`: the original v1 walkthrough.

Legend: **[decided]** = the owner decided it in conversation. **[my call]** = a default chosen by the designer, open to override. **[builder]** = left for the builder. **[unverified]** = a fact about an external source that research could not confirm. It must be checked before code depends on it.

---

## 1. Intent: what this is and why

A journalist has a 3-hour parliament session they won't watch end to end. They want to know **what was discussed** and **where the moments that matter are**, then turn some of those moments into material: a story, posts, something for an editor, or uses nobody has thought of yet. **[decided]**

Digestor becomes two products on one engine. **[decided]**

1. **A journalist's video editor driven by agentic AI.** Any long public-interest video goes in: parliament, trials, interviews, electoral debates, UN sessions or supreme-court sessions. The journalist gets a map of the session (topics plus highlights), then a full briefing they can shape. Shaping uses three controls: granularity (long exchanges vs. punchlines), focus (one person) and AI relevance. They confirm the moments they want, and only then are short or long cuts produced, with subtitles in any language.
2. **An automated parliamentary-participation tracker.** The same pipeline runs **solo**, with no human pauses, on every plenary session of the tracked chambers. It builds per-member metrics: speaking time, speeches, topics, interjections, presence and AI-judged highlights. Journalists use these to compare and monitor senators and deputies.

Switching a session between manual and solo must be cheap. The two modes share every screen; the only difference is whether the pipeline's pauses wait for a human. **[decided]**

What makes it different from clip tools: public-interest relevance, **every claim traceable to its source** (names, quotes, numbers), and a human in charge of anything published.

## 2. Goals, non-goals, anti-goals

### Goals
The work is delivered in three parts, in this order **[decided]**. Each gets its own implementation plan (§16).

- **(a) Preview → Full briefing → Export.**
  - A **Preview** shows topics, a summary and the top highlights, so the journalist can check that the AI is on the right track.
  - A **Full briefing** shows every moment found. It is shaped by **granularity**, **focus** and **relevance** controls that filter instantly.
  - After the journalist confirms, they prepare clips: trim, subtitles per language with approval, and format.
  - **Export** is the only step that cuts video.
  - It works for any uploaded video or YouTube link.
- **(b) Real speaker names and person focus.**
  - Voices get names from official records, on-screen captions and the human, and later from voiceprints.
  - Each name carries its source.
  - Focus narrows the briefing to one person.
- **(c) Solo tracking of the Brazilian Câmara dos Deputados and Senado Federal.**
  - New plenary sessions are fetched and processed automatically.
  - A Tracker home per chamber shows the next session, new sessions, a watchlist, a participation table and presence.
  - An archive-wide "Ask" box answers questions from stored data.
  - Germany (Bundestag) and the US (House and Senate floor) are **later additions**: the design must not block them, and §11 records what the sources offer. **[decided]**

### Non-goals (for now)
- **Accounts and teams.** There is one user now (the owner). Every personal record still carries an `owner_id`, so adding accounts later means adding a login, not migrating data. **[decided: several journalists later; my call: owner_id from day one]**
- **A translated interface.** The interface is English now, but built ready for i18n (§12). **[decided]**
- **Writing posts, captions or hashtags for the user.** The output is cuts, subtitles, the briefing text and data. Carried over from the v1 spec.
- **Live streams.** Only recorded sessions are processed.
- **Face recognition** of people on camera. **[my call — unreliable on wide plenary shots and ethically sensitive]**

### Anti-goals: hard rules
These would make Digestor a failure even if everything else works. **[decided: the first three are the owner's own words: misattributing quotes, topics or speakers, and cutting someone off before they finish a sentence or argument. my call: the rest]**

1. **Never misattribute.**
   - No name without a source. An uncertain match stays "Speaker C".
   - Quotes are the exact transcript words, linked to their moment.
   - Topics come from the record or the transcript, never invented.
2. **Never cut someone off.**
   - No cut lands mid-sentence (v1's `snapRange`).
   - No cut lands mid-argument without a visible warning (§9.4).
3. **Never mislead by context.**
   - Reported speech ("my opponent claims X") is flagged.
   - Interpreter audio is flagged.
   - Sarcasm, hypotheticals and similar traps get a context warning.
4. **Never mix judgments with facts.**
   - Counted values (speaking time, speeches, votes, presence) are kept apart from AI judgments ("most heated", "strong argument").
   - AI judgments always carry an **AI** badge and a "Why:".
5. **Never call someone absent without an official record** (§10).
6. **Never give a fact verdict.** "Claim to check" is a flag with a quote, never "true" or "false".
7. **Never silently change stored results.** Analyses are stored once and versioned (§13).
8. **Never publish a person who must be protected.** In trials and hearings, witnesses, victims and minors are not named or featured unless the human confirms it.
9. **When unsure, say so.** An honest "not in our data" or "unconfirmed" beats a confident guess.

## 3. Constraints

- **Stack and environment:** unchanged from the v1 spec and `CLAUDE.md`.
  - pnpm TypeScript monorepo; Next.js 16 web app; pg-boss and LangGraph worker; Postgres; Chroma (now used, for Ask).
  - Docker on Colima. ffmpeg and yt-dlp run only in the worker container.
  - Deployed to one VPS.
- **Time:** **no fixed deadline**. Build (a), (b) and (c) in order and see how long it takes. **[decided]** Each plan still orders its tasks so that a working slice ships early. **[my call]**
- **Data from Plan 1:** the dev database holds only throwaway sessions. Plan 2 may **wipe it**; no migration of v1 `clips` / `clip_events` is needed. **[my call]**
- **Budget:** automated tracking starts with **Brazil only** to keep running costs small. **[decided]** Before enabling solo mode, the builder estimates the weekly cost from one real week of Câmara and Senado sessions (hours × transcription price + LLM tokens) and shows it to the owner. **[my call]**
- **No processing that isn't needed.** Changing granularity, focus or relevance never triggers video work or a new AI pass (§6.3). Video is cut only at Export (manual mode) or by the tracker's clip-keeping step (solo mode, §8.4). **[decided]**
- **Storage and retention:** full session videos are kept for at most **14 days**; clips are kept long-term (§8.4). **[decided]**
- **Reuse terms:** exports carry the source's credit line and never crop out a source's logo or watermark (§11). **[decided: rules surfaced from the research; my call: enforcement]**
- **Determinism:** results are stored and versioned, never recomputed silently (§13). **[decided]**

## 4. Core concepts and vocabulary

| Concept | Meaning |
|---|---|
| **Session** | One video and everything derived from it. Either **uploaded** (by a user) or **tracked** (fetched by solo mode). |
| **Official analysis** | The pipeline's stored result for a session: transcript, topics, the moment pool, speaker attributions and the briefing. It is **versioned and never edited by users** (§13). For tracked sessions it feeds all metrics. |
| **Personal layer** | A user's own work on top of a session: selections, filters, trims, extra moments from "Find more", subtitle approvals, clips. Scoped by `owner_id`. It never changes the official analysis. **[decided]** |
| **Topic** | A contiguous stretch of the session about one subject (an agenda item, a debate question, a trial phase, depending on the profile), with a start, an end and a short summary. |
| **Moment** | A candidate span worth showing. It has a start and end (snapped), a granularity level, speakers, a topic, highlight types, a relevance score, "Why:" and evidence. **All moments are found once, up front, at every granularity** (§6.3). |
| **Highlight type** | A pluggable kind of highlight with a name, a colour and a detection method: *counted* (from data, e.g. "longest speech"), *marked* (from official records, e.g. laughter or applause markers) or *AI-judged* (e.g. "strong argument"). Adding one is configuration, not new screens. **[decided: flexibility; my call: the three methods]** |
| **Profile** | A preset per kind of video. It sets what counts as a topic, which highlight types apply, where names come from, which metrics exist and any special care (§7). It replaces and extends the v1 "event type". |
| **Person** | A registry entry, e.g. a deputy or senator with an official id, party, state and photo. Speakers in a session are linked to persons through **attributions** that carry a source. |
| **Presence evidence** | The strongest evidence that a member attended a session, labelled with its source (§10). |

The v1 labels (Heated / Key point / Light moment) become three highlight types in the Interview and "Other" profiles. The v1 clip tree (long clip → hot takes) becomes two granularity levels with an "inside" relation. **[my call]**

## 5. The journalist flow (manual mode)

> **Note (2026-11-05):** Preview (§5.3) and Full briefing (§5.4) are now **one Briefing page at `/s/[id]`**: a summary card on top (lead, timeline, top highlights, document actions, "Something's off") and one card per topic with its moment tree underneath; `/s/[id]/briefing` redirects there. The stepper is Upload › Processing › Context › Briefing › Prepare › Export. See `docs/superpowers/specs/2026-11-05-digestor-owner-review-batch-design.md`, "#15 One Briefing page". §5.3 and §5.4 below are kept as the original concept.

```
Upload ─► Processing ─► Context check + Who's who ─► Preview ─► Full briefing ─► Prepare clips ─► Export
                         (pause #1, only if needed)    (proof)    (shape + confirm)   (trim, subs)     (cut)
```

### 5.1 Upload and Processing
These are as built in Plan 1 (file or YouTube link, an optional hint, a live stage stepper). Changes:
- The pipeline stages grow to include *Finding topics*, *Naming speakers* and *Finding moments*.
- **Audio-only sources** (radio, podcasts, US Supreme Court arguments) are accepted after a **warning plus a checkbox the user must tick**. It says that clips will show a still image or waveform instead of video. **[decided]**

### 5.2 Context check and "Who's who" (pause #1)
The v1 context check stays and gains two parts. Like v1, it pauses only when something needs the human; otherwise it is a dismissible banner.
- **Profile confirmation:** a proposed profile (detected from title and metadata), which the user can change.
  - Pause #1 also triggers when profile detection is unsure.
  - Changing the profile **after** analysis is allowed. It starts an explicit re-run, which creates a new analysis version (§13), after a notice that it costs a new AI pass. **[my call]**
- **Who's who panel** (built in part b):
  - Each detected voice gets a short sample to play and a proposed name with a source badge (*from record*, *from caption*, *from voice*, *from you*).
  - The user can confirm or fix each one.
  - Unconfirmed voices stay "Speaker C". **[decided: sources; my call: panel]**

### 5.3 Preview: the proof step
The first screen when results are ready. Its job is to let the journalist judge quickly whether the AI understood the session. **[decided]**

The layout is agreed (see `docs/design/ui-concept-overview.html`): B's timeline concept with A's and C's sober, information-rich styling. **[decided]** From top to bottom:
1. **Header:** title, length, number of speakers, language and profile.
2. **Session timeline:**
   - A strip across the whole session with one band per topic, in neutral greys. The topic being read is dark.
   - Coloured dots mark the top highlights; colour is reserved for highlight types. There is a legend and a "⚙ Highlight types" entry.
   - Clicking a band or dot scrolls the briefing there, and scrolling the briefing moves the dark band. **[my call]**
3. **Top highlight cards:** one card per highlight type, showing its single best moment, with the time and length.
4. **Briefing (sober document style):**
   - A lead paragraph, then one section per topic, each with a summary, a key quote (original language, with the time) and its highlights inline.
   - Each highlight shows its "Why:" plus **▶ Play** and **+ Clip**.
   - Actions: *Copy text*, *Share link*, *Export…*.
  - *Share link* is a deep link that only people who can log in can open: today that means whoever has the app password. A public read-only link (signed token, a middleware exception, Preview only) is a later, deliberate addition. **[my call, as proposed in conversation]**
   - The briefing is written in the **video's original language**. The reader can show a translation in their own language; translations are created on first request and stored (§12). **[decided]**

Below the briefing:
- **Looks right → Full briefing** continues the flow.
- **Something's off** offers two routes: back to the context check, or *Report a problem*. **[my call]**

**▶ Play** streams the existing 480p proxy between the moment's start and end (Range requests and `#t=` fragments, as built). **Nothing is cut.** **[decided]**

### 5.4 Full briefing: shape and confirm
This is everything the pipeline found, organised by topic, with three controls. **All three filter the stored moment pool on screen, instantly, with no AI call and no video work.** **[decided]**

| Control | What it does |
|---|---|
| **Granularity** | A dial with three stops. Levels are **[my call; builder tunes the ranges]**: **Exchange** (long, self-contained, about 2–12 min: a two-person debate, a whole relevant speech, an escalation), **Passage** (about 30 s–2 min), **Punchline** (about 8–30 s). Moments inside a longer moment are shown nested. |
| **Focus** | A magnifier and person picker, limited to the people in this session. It shows only moments where that person speaks, or is addressed (**[my call]**). If the pool for that person is thin, a button **"Find more moments with <name>"** runs one **text-only** AI pass over that person's passages. It takes seconds to a minute, never touches video, never runs automatically, and its results go into the **personal layer**. **[decided: no heavy reprocessing; my call: the button]** |
| **Relevance** | A minimum-relevance slider (or "top N") plus highlight-type chips. Moments are sorted by the AI's relevance score; counted and marked types sort by their own values. |

Each moment row shows:
- the time and length
- the speaker or speakers, with source badges
- the highlight-type chips
- "Why:"
- an excerpt in the original language
- **▶ Play**
- a **select** control

The keyboard triage from Plan 1 carries over: **A** select (approve), **N** neutral, **R** reject, **↓/↑** move, **E** open in clip preparation. The rules in the `digestor-ui` skill still apply: ignore keys while typing or when the key repeats, and send status changes in order with the latest winning. **[my call: the inbox's triage moves here; the inbox screen retires]**

**Confirm selection → Prepare clips** moves the selected moments on. Confirming is **not a lock**:
- The selection lives in the personal layer.
- The user can return to the Full briefing, change it, add from Preview with "+ Clip", and export again as often as they like.
- The analysis graph ends when the official analysis is stored. Exports are separate render jobs. **[my call]**

### 5.5 Prepare clips
For each selected moment:
- **Trim:**
  - A player on the proxy, with a zoomed strip whose handles **snap to sentence pauses** (a modifier key turns snapping off), plus exact time fields.
  - The session timeline doubles as the v1 "heat" overview.
- **Checks** (§9.4): speaker confirmed, sentence and argument complete, context warnings, reported speech or interpreter flags.
- **Format:** 16:9, or **vertical 9:16** (§9.2).
- **Subtitles:** choose any number of languages (§9.3).

Nothing is cut here either; it all plays from the proxy.

### 5.6 Export
- The **pre-export checklist** must pass (§9.4).
- Clips render (cut plus optional burned-in subtitles) **only now**. **[decided]**
- Downloads:
  - MP4 per clip, and per burned language
  - subtitle files per language
  - the briefing as text or a document
- The responsible-use notice from v1 stays.

## 6. The engine behind it

### 6.1 Pipeline changes (manual and solo)
The v1 LangGraph pipeline stays: download → ingest → transcribe → context → (pause #1) → find → (pause #2) → render. **[my call]** Changes:
- **`find_topics`** (new): segments the transcript into topics, using the official agenda or record when one exists.
- **`name_speakers`** (new, part b): runs the attribution sources (§11) and writes attributions with source and confidence.
- **`find_moments`** (replaces `find_clips`):
  - Produces the **moment pool** at all three granularities.
  - Each moment is tagged with speakers, topic, highlight types and relevance.
  - It follows the `llm-structured-output` rules: lenient output schemas, caps and checks in code, per-item drops, failing the smallest unit.
  - Counted and marked highlight types are computed in code from the transcript and records, not by the LLM.
- **`write_briefing`** (new): the lead paragraph and per-topic summaries in the original language, each sentence linked to evidence moments.
- **`checks`** (new): argument completeness and context checks (§9.4).
  - Run during analysis **only on the top highlights**, so the Preview can show warnings.
  - Every other moment is checked **the first time it is selected**: a small text-only call whose result is stored on the moment within its analysis version.
  - This follows the owner's rule against processing that isn't needed. **[my call]**
- **The graph ends once the official analysis is stored.** v1's pause #2 (review) and the `render` node leave the graph:
  - The Full briefing confirmation is personal-layer state, not a graph pause.
  - Export enqueues render jobs (the existing `claimClipRender` / `finishClipRender` guards apply). **[my call]**
- **Solo mode:** both pauses auto-resolve. The context check takes the agent's draft, and confirmation takes the clip-keeping rule in §8.4.

### 6.2 Cost discipline
- Expensive work (transcription, `find_topics`, `find_moments`, `write_briefing`, `checks`) runs **once per analysis version**.
- On-demand AI work is limited to:
  - Find more (personal layer)
  - translations (cached)
  - Ask answers
  - subtitle translation of selected clips

### 6.3 Why the filters are instant
The moment pool is precomputed and stored with every attribute a filter needs. Granularity, focus and relevance are queries over stored rows, so the client can filter them in memory for one session. **[decided: the principle; my call: client-side]**

## 7. Profiles

Each profile is data (like v1 event types): topic definition, highlight types, naming sources, metrics, special care and prompt rubric. The profile is detected and the human confirms it. **[decided: keep any-video uploads; my call: the profiles below]**

| Profile | Topics are… | Highlight types | Names from | Metrics and special care |
|---|---|---|---|---|
| **Parliament** | agenda items | Most heated, Strong argument, Longest speech (counted), Laughter and Applause (marked, from records), Interjections (marked or counted), Most discussed topic (counted) | record, caption, voice, human | participation (tracked chambers only) |
| **Supreme court** (e.g. Brazil's STF) | cases on the agenda | Vote (per justice), Divergence, Request for review ("pedido de vista"), Clash between justices, Result | fixed list of justices, caption, human | votes per justice and alignment between justices (if tracked later) |
| **Electoral debate** | the moderator's questions or themes | Attack & rebuttal, Promise, Dodged the question, Punchline, **Claim to check** | caption, human | speaking-time balance and interruptions per candidate |
| **Trial / hearing** | phases: opening, testimony, cross-examination, objections, ruling | Key testimony, Objection + ruling, Contradiction, Emotional moment (no Laughter type) | caption, human | **sensitive by default** (anti-goal 8) |
| **Interview** | the questions asked | News line, Quotable, Dodge, Emotional moment, plus the v1 Heated, Key point and Light moment | caption, human (usually 2 people) | none |
| **UN session** | agenda items or country statements | Strong statement, Explanation of vote, Right of reply, Walkout or protest | caption, UN meeting records, human | positions per country; **interpreter audio flagged** |
| **Other** | detected sections | v1 Heated, Key point, Light moment | caption, human | none |

Every AI-judged type shows the **AI** badge and "Why:". Counted and marked types show their source ("from record", "counted").

## 8. The Tracker (part c, solo mode)

### 8.1 Scope
Tracking starts with the **Câmara dos Deputados** and the **Senado Federal**, plenary sessions only. **[decided]** Each chamber is a **connector** (§11) that provides:
- the session list and schedule
- the video source
- records for naming
- attendance
- the member registry

The Bundestag, US House and US Senate are added later as more connectors.

### 8.2 Tracker home
See `docs/design/ui-concept-tracker.html`. **[decided: owner approved the proposal; next-session rule added by the owner]**
- **Chamber tabs** and a week picker.
- **Next session:** each chamber shows the date and time of its next session **whenever nothing is processing**. **[decided]**
- **New sessions:** processed automatically. Each shows its length, speakers, top highlights and naming status ("Names from record" or "Provisional names"). Opening one leads into the same Preview → Full briefing → Export flow.
- **Watchlist:** people the user follows, showing what each did in the selected week, including "didn't speak". Focus in the tracker is **only this viewing feature**: it never changes analyses or metrics. **[decided]**
- **Participation table:** per member or per party, sortable, with a comparison view.
  - Counted columns: speeches, speaking time, interjections made and received, topics.
  - A presence column (§10).
  - AI-judged columns, labelled AI.
  - **Every number clicks through to the moments or records it was computed from.**
- **Alerts:** in-app only (a marker on the watchlist entry when someone spoke). Email is later. **[my call]**

### 8.3 Ingestion
- A scheduled job per connector checks the chamber's session list and starts a session once its recording is available. **[my call]**
- Only finished, recorded sessions are processed.
- Downloads use the connector's video source.
- YouTube downloads from a datacenter IP may be blocked (a v1 spec risk). The connector should prefer official direct video URLs where they exist. **[builder]**

### 8.4 Retention and clip keeping
- **Full session videos (original and proxy) are deleted after 14 days.** **[decided]**
- *My call:* the same 14-day limit applies to uploaded sessions' videos.
  - Their analysis, the user's personal layer and every clip the user exported are kept until the user deletes them.
  - This replaces v1's `RETENTION_DAYS` = 7 whole-session deletion **from Plan 2 on**, so personal work is never wiped by the old rule.
  - After 14 days, an uploaded session can't produce *new* cuts until the user re-uploads the video. The Preview says so.
- **Clip keeping in solo mode:** before the 14 days run out, the tracker cuts and stores the session's highlights.
  - *My call:* all moments that are a top highlight of any type, plus all moments of watchlisted people.
  - They are stored at **720p H.264, without burned subtitles**. Subtitles are applied at export, so any language still works later. **[decided: keep long-term, 720p; my call: no burned subtitles]**
- After deletion:
  - The briefing shows transcripts, and plays only the kept clips.
  - For tracked sessions, a journalist who needs a new cut can **re-fetch** the public video from the official source; this is an explicit action. **[my call]**

### 8.5 Provisional and final names
- Names from captions are **provisional** until the official record is published.
- When it arrives, attribution re-runs **as a new, labelled version** (§13). Example: "Names updated from the official record on 4 Nov".
- Metrics show which version they come from.

## 9. Export, subtitles and pre-export checks

### 9.1 What is cut
Only confirmed clips, only at Export (manual) or clip keeping (solo). Cuts start from the original if it still exists, otherwise from the kept 720p clip.

### 9.2 Format
- Formats are 16:9 or vertical 9:16.
- *My call:* 9:16 uses a centred crop with a horizontal offset the user can adjust in Prepare clips. Automatic speaker tracking comes later.
- The crop must never remove the source's logo or watermark. If it would, the export overlays the source credit and warns. **[builder: exact approach]**
- This reverses the v1 non-goal on vertical video. **[decided: the owner listed posting as a use]**

### 9.3 Subtitles in any language
**[decided]**
1. The user picks languages for a clip, e.g. English, German and French.
2. A **subtitle file per language** is generated from the clip's transcript lines (translated if needed). This is cheap and cuts nothing. Files are SRT and WebVTT. **[my call: formats]**
3. Separate subtitle files are the default output and can be downloaded at any time.
4. **Burned-in subtitles come only after approval.** The user reviews each language's lines next to the original, can edit a line, and approves that language. Each approved language can be burned into its own MP4 version.
5. Approval is per language, so English can be approved today and German tomorrow.
6. The original-language track is always available.

### 9.4 Pre-export checklist and per-moment checks
Shown per clip in Prepare clips and summarised before Export. **[decided: concerns; my call: mechanics]**

1. **Speaker confirmed.** A clip whose speaker attribution isn't confirmed (record or human) can't be exported until the user confirms the name or chooses "no name".
2. **Sentence and argument complete.**
   - Boundaries are snapped (v1).
   - In addition, the `checks` step asks whether the point is finished at the end, and whether a question is left unanswered.
   - If not, the clip shows **"The argument continues"** with the next sentence, and a one-click **Extend**.
3. **Context warnings seen.** These cover the possibility that the clip alone suggests the opposite of the full passage (sarcasm, hypotheticals, quoting opponents). They are warnings, never silent blocks.
4. **Flags:** *quoting someone else* and *interpreter audio*.
5. **Subtitles approved** for every burned language.
6. **Credit line added** (from the connector or profile; editable for uploads).

### 9.5 Report a problem
Every moment, attribution, quote and metric has **Report a problem**. Reports go to a log, the owner reviews them, and they guide prompt and rule changes. **[decided: the owner can't foresee every edge case; my call: mechanism]**

## 10. Presence

No tracked or researched chamber publishes a plain "who was in the room" list. Presence is shown as **evidence levels**, strongest first, each labelled with its source. **[decided: concept; research below]**

1. **Official attendance record:** present, excused, absent, on mission or on leave, as the chamber recorded it.
2. **Voted** in a roll call in that session.
3. **Spoke** (a confirmed attribution).
4. **No evidence:** shown as exactly that.

**"Absent" is shown only when an official record says so.** "Didn't vote", "Not Voting", "nicht abgegeben" or no row are never turned into "absent". **[decided]**

| Chamber | What exists | "Absent" shown only when… |
|---|---|---|
| Senado | Per-vote attendance codes (`tiposComparecimento`, **verified live**): SF/PSF present, P-NRV present-did-not-vote, NCom did not attend, AUS absence communicated, MIS mission, L1–L4 / LS leave, OB obstruction, VO voted, PS/PR presided. Per-senator payload in the new `/dadosabertos/votacao` API is **[unverified]** | code is AUS or NCom. MIS and leave are shown as such |
| Câmara | Yearly bulk files `eventosPresencaDeputados-{ano}` (attendees per event, all event types: filter to plenary); vote records `votacoesVotos-{ano}` | never automatically (the file lists only those present). Per-event endpoint and absence justifications are **[unverified]** |
| Bundestag (later) | Plenarprotokoll annex "Liste der entschuldigten Abgeordneten"; per-vote lists for recorded votes (XLSX/PDF) | the member is on the excused list (noting that "excused" is a request). Whether the annex is in the open-data XML is **[unverified]** |
| US House (later) | Roll calls only: Yea / Nay / Present / Not Voting; quorum calls (**verified live**) | never |
| US Senate (later) | Roll calls (**[unverified]**, the site blocked automated fetches) | never |

## 11. Naming speakers and the chamber connectors

### 11.1 Name sources
Each source writes an attribution with its source, evidence and confidence. **[decided: sources; my call: order]**

| Source | How | Badge |
|---|---|---|
| Official record | Match our transcript to the official speech list or text (speech order plus text similarity), using clock times when the record has them | from record |
| On-screen captions | Sample frames; a vision-capable LLM reads name captions; matched to the person registry | from caption |
| Voiceprint (part c) | Store a voice embedding per confirmed person and match it in later sessions | from voice |
| Human | Confirm or fix in Who's who or anywhere a name appears | from you (purple) |

- Unmatched speakers stay "Speaker C".
- Presidents and chairs are named like anyone else.
- *Open for the builder:* the voiceprint technology. Most speaker-embedding models are Python, so this may need a small sidecar service or a hosted API. **[builder]**

### 11.2 Brazil (part c)

| Need | Câmara dos Deputados | Senado Federal |
|---|---|---|
| Member registry | API `/deputados`, `/deputados/{id}` (id, name, party, UF, photo) | `/senador/lista/atual`, `/senador/{codigo}` |
| Speeches for naming | API v2 `/deputados/{id}/discursos`: `dataHoraInicio` / `dataHoraFim` (wall-clock, **[unverified]**), `sumario`, `transcricao`, keywords; stenographic notes with a "Hora, Fase, Orador" table | `/dadosabertos/plenario/lista/discursos/{ini}/{fim}.json` (**verified live**): speaker code, name, party, UF, summary, keywords, full text, interrupters (`Apartes`). **No per-speech time**, so naming is by text match within the session |
| Laughter, applause, interruptions | Stenographic-note markers ("risos", "palmas", "apartes"); details **[unverified]** | Apartes in speech data; note markers **[unverified]** |
| Sessions, schedule and video | `/eventos` (session start and end, `urlRegistro` video link); future events give the next session | Video source and agenda API **[unverified]** |
| Attendance | §10 | §10 |
| Reuse terms | Chamber recordings **CC BY 4.0**: credit required and watermark must stay. Other TV Câmara content is CC BY-NC-ND | **[unverified]** |
| Access | No key, JSON | No key, JSON or XML; the old `plenario/lista/votacao` endpoint is deprecated |

The Câmara API host returned 504 during research. The builder must make real calls and confirm the schemas before locking them. **[unverified]**

### 11.3 Later connectors (recorded so the design doesn't block them)
- **Bundestag:**
  - Plenarprotokolle are open-data XML and name every speech in order, with interjections and markers like "(Heiterkeit)" and "(Beifall)". They have **no per-speech times**.
  - Open Parliament TV aligns Bundestag video and protocol at sentence level (its data licence and coverage are **[unverified]**).
  - Members: MdB-Stammdaten XML; abgeordnetenwatch API (CC0).
  - Video: Bundestag Mediathek. Reuse requires the credit "Deutscher Bundestag" and the eagle logo must stay visible.
  - Protocols probably appear within days **[unverified]**.
- **US House floor:**
  - The Clerk's daily Floor Summary XML (`clerk.house.gov/floor/YYYYMMDD.xml`) timestamps every floor action **to the second** (**verified live**). Names are inside the action text.
  - Roll-call XML (`clerk.house.gov/evs/{year}/roll{NNN}.xml`) gives per-member votes with Bioguide ids (**verified live**).
  - `unitedstates/congress-legislators` (CC0) maps ids across systems.
  - The next session is shown on the Floor Summary page.
  - The source for downloading full session video is **[unverified]** (the live stream is on the Clerk's YouTube channel).
- **US Senate floor:**
  - **[unverified]**: senate.gov refused automated fetches, so the owner needs to check it from a browser.
  - Expect roll-call XML with LIS ids, the Congressional Record (via GovInfo API, free api.data.gov key), and no timed floor log, so naming is by text matching.
  - **Congressional Record caveat:** members can "revise and extend" their remarks, so it can be used to help name speakers but **never for speaking time**.
  - Government-camera floor video is probably public domain (17 U.S.C. §105), but this is **[unverified]**. C-SPAN's own productions have separate terms. Confirm before storing clips long-term.

## 12. Languages and i18n

**[decided]**
- **Analysis and briefing:** written in the video's original language. This is the stored, official version.
- **Translation for reading:**
  - The user can view a translation in their language.
  - It is created on first request and stored with the source text's version.
  - Quotes always show the **original with the translation beneath**.
- **Subtitles:** any language per clip (§9.3).
- **Interface:** English now, built for i18n from the start.
  - All UI strings live in message catalogues, not inline in components. **[builder: library, e.g. next-intl]**
  - Dates, times and numbers are formatted with the viewer's locale.
  - Transcript and quote elements carry `lang` and `dir="auto"` (see the `digestor-ui` skill).

## 13. Determinism and versions

**[decided: stored deterministically; focus never changes results; my call: versioning mechanics]**
- Each official analysis has a **version**, recording: pipeline version, model ids, prompt versions, and record-source snapshot dates.
- Screens and metrics read stored rows; nothing is recomputed on view.
- **Re-running** (a better prompt, a new model, an official record arriving) is an explicit action or a scheduled rule. It creates a **new version**:
  - The previous version stays readable.
  - The UI shows which version is current and why it changed.
- Metrics state the analysis version they were computed from. Comparisons across sessions note when versions differ.
- Personal layers reference moments by id within a version. When a newer version replaces the current one, a personal layer keeps working against the version it was built on, and offers to move. **[builder: details]**

## 14. Ask: questions answered from stored data

The v1 copilot becomes **Ask**. It sits in two places: inside a session (the briefing) and in the Tracker (across all sessions and chambers). **[decided: the owner's example questions; my call: shape]**

| Example question | Answered from | Answer shape |
|---|---|---|
| "When did Senator X speak?" | Stored attributions | Exact list of sessions and times, each a clickable moment |
| "What did Senator X say about healthcare?" | Chroma search over X's transcript passages (RAG), then a summary | Quotes with timestamps; the summary is labelled AI and each sentence links to its source |
| "Was Deputy Y present?" | Presence evidence (§10) | Evidence level and source, never a guess |

- Ask is a tool-calling agent, with tools such as:
  - `search_transcript`
  - `list_speeches(person, range)`
  - `presence(person, session)`
  - `list_moments(filter)`
  - `get_metrics`
  - `propose_clip`
- It follows the `llm-structured-output` rules for tool arguments.
- It **acts only on the personal layer.** This keeps v1's function-calling edits, within that layer:
  - It can propose a clip, trim a selected clip, or select and deselect moments, e.g. "start clip 3 when she begins answering".
  - Every change is shown as a tool chip and can be undone.
  - Bulk changes need confirmation in the interface.
  - It never edits the official analysis, never renders and never exports. **[my call]**
- When the data doesn't hold the answer, it says so.
- This is where the capstone's RAG, vector database and function calling requirements live.

## 14a. Evaluation

v1 spec §10 still applies. The golden-set script grows with the new outputs. **[my call]**
- **Topics:** boundary error against hand-labelled topics.
- **Moments per granularity:** golden moments found, and boundary error.
- **Attributions** (part b): share of speaking time named correctly; **wrong names count far worse than "Speaker C"**.
- **Checks:** do the argument and context warnings fire on a few hand-made traps (a clip cut mid-argument, a quoted opponent)?

The golden set should include one Câmara or Senado session alongside the v1 interview. Results go in the README, as the capstone requires.

## 15. Data model additions

**[my call; builder refines]**
- `persons` (registry: official ids per chamber, name, party, state, photo URL, active periods)
- `chambers` / `connectors` (config, last poll, next session)
- `analysis_versions` (session, version, pipeline/model/prompt versions, created_at, reason)
- `topics` (version, start, end, title, summary)
- `moments` (version, start, end, granularity, topic, relevance, why, evidence, checks JSON, `inside_moment_id`)
- `moment_highlights` (moment, highlight type, method, value)
- `attributions` (version, diarized speaker, person, source, evidence, confidence, confirmed_by)
- `presence` (session, person, level, source, raw code)
- `metrics` (version, person, session, metric, value)
- `personal_layers`, `selections`, `user_clips` (owner_id, …)
- `subtitle_tracks` (clip, language, lines, approved_at)
- `translations` (source id, language, text, version)
- `problem_reports`
- `kept_clips` (storage key, quality)

## 16. Delivery order

Each part gets its own implementation plan, written with superpowers:writing-plans, in this order. **[decided: a, b, c]**

1. **Plan 2: part (a).**
   - Profiles; the topic and moment pool; the briefing.
   - The Preview and Full briefing screens with instant filters (focus works on diarized "Speaker A/B" until part b).
   - Prepare clips: trim, checks, formats, multi-language subtitles with approval.
   - Export-only cutting.
   - Analysis versions; `owner_id`; i18n scaffolding; Ask inside a session (RAG plus tools).
   - The new retention rule (§8.4); the evaluation updates (§14a).
   - It replaces the v1 review inbox screen. The inbox's tested logic (`lib/review.ts`, `lib/statusQueue.ts`) moves into the Full briefing.
   - It also absorbs the Plan 1 backlog in the SDD ledger:
     - lenient label and score schemas
     - a sweep for sessions stuck after a final-attempt crash
     - `filename*` for downloads
     - yt-dlp size cap and live filter
     - language override
     - detaching out-of-bounds children
     - a dismissible context banner
2. **Plan 3: part (b).**
   - The person registry.
   - Attribution from captions and from the Câmara and Senado records.
   - The Who's who panel; focus by real person; "Find more moments with <name>".
   - Export blocked on unconfirmed speakers.
3. **Plan 4: part (c).**
   - Câmara and Senado connectors: sessions, schedule, video, attendance.
   - The solo-mode scheduler; 14-day retention with clip keeping.
   - The Tracker home: watchlist, participation table, presence.
   - Provisional-to-record re-versioning; Ask across sessions; voiceprints.
   - A cost estimate before switching solo mode on.

## 17. Risks

| Risk | Mitigation |
|---|---|
| Wrong speaker named | Source-labelled attributions; unconfirmed stays "Speaker C"; export blocked until confirmed; record-based re-versioning |
| Clip misleads (cut short or out of context) | Snapping, argument-completeness check, context warnings, reported-speech and interpreter flags, human approval |
| Brazilian APIs differ from the research | Every unverified item is flagged; the builder makes real calls before locking schemas; connectors are isolated |
| YouTube blocks the server's downloads | Prefer official direct video URLs; clear error; manual upload always available |
| Tracking costs grow | Brazil only at first; one analysis per version; on-demand work cached; cost estimate before enabling |
| Disk fills | 14-day video retention; kept clips at a fixed quality |
| Metrics read as judgments | Counted vs. AI columns kept apart; every number links to its evidence; presence evidence levels |
| Stored results drift | Versioned analyses; no silent recompute |
| Re-using footage breaks terms | Credit line on every export; no cropping of logos or watermarks; licence check per connector |

## 18. Left to the builder and open decisions

- **Decided at review:** kept clips are stored at 720p (§8.4); Plan 1 (`plan-1-core-loop`) is merged into `main` before Plan 2 starts.
- **Builder:**
  - exact granularity ranges and relevance thresholds
  - the i18n library
  - the voiceprint technology
  - the 9:16 crop mechanics
  - the connector polling cadence
  - how personal layers move to a new analysis version
  - exact visual styling within the `digestor-ui` rules (the mockups are inspiration)
- **Calls made by the designer** (marked **[my call]** above), for the owner to check:
  - the inbox screen retires and its triage moves into the Full briefing
  - three granularity levels
  - focus includes being addressed
  - 14-day video retention also applies to uploads
  - which clips solo mode keeps, and at 720p without burned subtitles
  - in-app alerts only
  - SRT and WebVTT subtitle formats
  - 9:16 centred crop with a manual offset
  - Ask acts only on the personal layer, with undo
  - no fixed deadline; v1 dev data may be wiped
  - changing the profile after analysis means an explicit, paid re-run
  - confirming isn't a lock; the graph ends at the stored analysis
  - context and argument checks run lazily, except on top highlights
  - Share link needs login for now
  - the new retention rule applies from Plan 2
  - uploads can't produce new cuts after 14 days without a re-upload
  - evaluation extended

## Appendix: research sources (checked 2026-10-30)

Brazil:
- https://dadosabertos.camara.leg.br/swagger/api.html
- https://legis.senado.leg.br/dadosabertos/docs/
- https://legis.senado.leg.br/dadosabertos/plenario/lista/tiposComparecimento
- https://legis.senado.leg.br/dadosabertos/v3/api-docs
- https://www2.camara.leg.br/legin/int/portar/2013/portaria-327-31-julho-2013-776753-normaatualizada-cd-dg.html (CC BY 4.0 for Câmara recordings)

Germany:
- https://www.bundestag.de/services/opendata
- https://www.bundestag.de/mediathek/nutzungsbedingungen-247892
- https://github.com/OpenParliamentTV/OpenParliamentTV-Platform
- https://www.abgeordnetenwatch.de/api

USA:
- https://clerk.house.gov/FloorSummary
- https://clerk.house.gov/evs/2026/roll100.xml
- https://github.com/usgpo/api
- https://github.com/LibraryOfCongress/api.congress.gov
- https://github.com/unitedstates/congress-legislators
