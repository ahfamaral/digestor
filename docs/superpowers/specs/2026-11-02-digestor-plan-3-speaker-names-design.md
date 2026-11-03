# Digestor Plan 3: Real speaker names and person focus

**Date:** 2026-11-02
**Status:** Approved by owner 2026-11-02, with every [my call] as written
**Builds on:** `2026-10-30-digestor-ui-concept-design.md` (the "concept spec"), part (b) in §2, §5.2, §5.4, §9.4, §11 and §16. Where this document and the concept spec disagree, this document wins for Plan 3. Everything the concept spec says about part (b) still holds unless changed here.

Legend, as in the concept spec: **[decided]** = the owner decided it (in the concept spec). **[my call]** = a default chosen while writing this design; the owner can override it. **[builder]** = left to the builder. **[unverified]** = an external fact that must be checked with real calls before code depends on it.

The owner asked for this design to be written from the spec without a question round, so every **[my call]** below is unconfirmed and is listed again in §14.

---

## 1. Intent

Today every screen says "Speaker A", "Speaker B". A journalist can't use a clip, a quote or a focus filter until they know who is talking, and a wrong name is the worst mistake Digestor can make (anti-goal 1: never misattribute). Plan 3 gives voices real names. Each name shows where it came from, and only a confirmed name reaches an export. **[decided]**

Success looks like this:
- On the 2 h Globo debate, the three voices show as Tralli, Flávio Bolsonaro and Lula on every screen, each with a source badge, after one click to confirm. The session's context card already holds these names, but no screen shows them yet.
- On a Senado plenary session, most speaking time is named from the official record without the journalist typing a name. Anyone the record doesn't cover stays "Speaker C".
- Focus on "Flávio Bolsonaro" shows only his moments. If there are few, "Find more moments with Flávio Bolsonaro" adds more to the journalist's own layer in under a minute.
- A clip with an unconfirmed speaker can't be exported.

## 2. Where we start (state of `main` at c7464a3)

- **Diarization.** AssemblyAI `speaker_labels` gives each word a speaker id ("A", "B", …). Moments store the diarized ids that speak in them (`moments.speakers`). Diarization quality over a 40-speaker plenary is unknown and probably merges and splits voices (§6.3).
- **Names exist but are hidden.** The context agent proposes `participants` on the context card: `speakerId` → `name`, `role` and `affiliation` facts, each with `source` `video` | `metadata` | `human` and evidence, grounded in code (`groundContext`). The human can edit them in the context check (`cardEdits`). They feed the prompts and Ask's "known participants". The Preview, Full briefing, Prepare and Export show only "Speaker A" (`t("briefing.speaker", { id })`).
- **Focus** filters by diarized id (`BriefingFilters.speaker`, URL `s=`), with each speaker's share of words.
- **Export checklist** (`packages/core/src/checklist.ts`) has `argument`, `context`, `flags`, `subtitles`, `credit` and, for `trial`, `protected`. There is no speaker item.
- **Personal moments** exist (`moments.owner_id`, `origin` `ask` | `user`) and are never nested.
- **Frames.** The worker can grab a frame (`thumbnail` in `media/ffmpeg.ts`) for top highlights. No LLM call takes images yet (`StructuredLLM` is text only).
- **Golden eval** for the debate (session `7433d1c6`) has topics, moments and traps, but no speaker labels.

## 3. Goals, non-goals, anti-goals

### Goals
1. **One place for names: attributions.** Each name links a voice (over a time range) to a person, with its source, evidence and confidence, and whether a human or the record confirmed it. Every screen reads names from there. **[decided: sources and badges; my call: one place]**
2. **Name sources, in this plan:**
   - official record (Senado first, Câmara if its API allows it, §7.4);
   - on-screen captions read by a vision model (§7.3);
   - what the transcript and video metadata say, from the existing context agent (§7.2);
   - the human (§8).

   Voiceprints are Plan 4. **[decided]**
3. **Person registry:** a `persons` table. It has official persons (Senado and Câmara members, with their official ids, party, state and photo) and persons a human or a caption introduced (e.g. a TV moderator). **[decided]**
4. **Who's who:**
   - In the context check, each voice gets a sample to play, the proposed name and a source badge, with confirm, fix and "no name". **[decided]**
   - After analysis, the same panel opens from the Preview header and from any speaker name. **[my call]**
5. **Focus by person,** and **"Find more moments with <name>"** as one text-only pass whose results go to the personal layer. **[decided]**
6. **Export blocked on unconfirmed speakers.** A new checklist item passes when every person speaking in the clip is confirmed (record or human) or marked "no name". **[decided]**
7. **An attribution metric in the eval:** the share of speaking time named correctly, wrongly or not at all, with wrong names weighted far worse. **[decided: metric; my call: weight ×5]**

### Non-goals (Plan 3)
- Voiceprints and cross-session voice matching (Plan 4). **[decided]**
- Chamber connectors that fetch sessions, schedules, video or attendance on their own, and the Tracker (Plan 4). In Plan 3 the journalist links the official record by hand (§7.4). **[my call]**
- Re-versioning when a record arrives later ("Names updated from the official record on 4 Nov") (Plan 4, concept spec §8.5). **[decided]**
- Face recognition. **[decided]**
- A fixed registry for supreme-court justices or UN delegations; captions and the human cover them for now. **[my call]**
- "Addressed" in focus (concept spec §5.4: "where that person speaks, or is addressed"). It needs an AI judgment per moment. Plan 3 focus means **speaks in the moment**; "addressed" is deferred. **[my call, a change from the concept spec's my-call]**

### Anti-goals (hard rules, from the concept spec)
- **No name without a source.** An uncertain match stays "Speaker C". A proposal is never shown as a fact: provisional names carry their badge everywhere and need confirmation before export.
- **Wrong is worse than unnamed.** Every threshold in §7 leans towards "Speaker C". The eval weights wrong names ×5.
- **Protected persons.** In a `sensitive` profile (`trial`), an AI-proposed name appears only in Who's who, as a proposal. Everywhere else the voice stays "Speaker C" until a human confirms it. Subtitles never carry names. **[decided: anti-goal 8; my call: mechanics]**
- **Never silently change stored results.** Name changes are explicit, labelled human or record actions with history (§5). AI text written before a name changed is not rewritten silently: a notice offers a re-analysis (§8.4).

## 4. Concepts

| Concept | Meaning |
|---|---|
| **Voice** | A diarized speaker id in one session's transcript ("A", "B"). It is what AssemblyAI heard, not a person. |
| **Turn** | A maximal run of consecutive words by one voice. Turns are computed from the stored transcript; they aren't stored. |
| **Person** | A registry entry (§5.1). |
| **Attribution** | "Voice B, from t1 to t2 (or the whole session), is person P", with a source, evidence, confidence and status (§5.2). |
| **Source and badge** | `record` → *from record*; `caption` → *from caption*; `transcript` → *from transcript* (a name said aloud or in the hint); `metadata` → *from video details*; `human` → *from you* (purple). **[decided: record, caption, voice, you; my call: transcript and metadata badges, because the context agent already produces these and hiding the source would break "no name without a source"]** |
| **Confirmed** | Status `confirmed` means `record` above its threshold, or any human confirmation. Everything else is `proposed`. A voice with no attribution is unnamed. A voice a human marked "no name" is `anonymous`: it stays "Speaker C" and counts as resolved for export. **[decided: record or human]** |

## 5. Data model **[my call; builder refines]**

### 5.1 `persons`
- `id` (uuid), `display_name`, `full_name` (nullable)
- `kind`: `official` | `custom`
- `party`, `state` (UF), `role`: nullable text
- `photo_url` (nullable; never fetched by the browser from a third party without the builder checking terms; may be cached in storage **[builder]**)
- `official_ids` (jsonb, e.g. `{ "senado": "5894", "camara": "204554" }`), with a unique index per key
- `created_by` (`OWNER_ID`, `record`, `caption`), `created_at`

Official persons are imported **on demand**: when a record match or a caption names a member, the builder fetches that member from the chamber's registry API and upserts it. A full registry import is Plan 4. Custom persons are created when a human types a name that matches no person, or when a caption names someone not in the registry. Before creating a custom person, the panel offers close matches (normalised name, accents ignored) so "Lula" and "Luiz Inácio Lula da Silva" don't become two people.

### 5.2 `attributions` (session-level, with history)
- `id`, `session_id`
- `speaker_id` (diarized voice)
- `start_ms` / `end_ms`: nullable; null means the whole session
- `person_id`: nullable; null with status `anonymous` means "no name"
- `source`: `record` | `caption` | `transcript` | `metadata` | `human`
- `status`: `proposed` | `confirmed` | `anonymous` | `rejected`
- `confidence`: 0–1 (`human` = 1)
- `evidence` (jsonb, per source):
  - record: speech id, text-similarity score, record URL and fetch date;
  - caption: the frame's storage key, the text read and its time;
  - transcript or metadata: the quote;
  - human: nothing.
- `created_by`, `created_at`, `superseded_at`: nullable; a row is current while this is null.

**Why session-level and not per analysis version:**
- Attributions belong to the transcript's voices, and a re-analysis reuses the transcript.
- A confirmation must survive re-analysis, so a journalist never confirms the same names twice.
- Each analysis version records the attribution snapshot it was written with (`analysis_versions.names_at`, a timestamp). The UI can then say when names changed after the AI text was written (§8.4).
- This deviates from the concept spec's data model sketch (`attributions (version, …)`). **[my call]**

**History, never overwrite:** a change inserts a new row and sets `superseded_at` on the old one, in one transaction. A human action supersedes AI rows for the same voice and range; a later AI run never supersedes a human row. Concurrency follows the repo rule: guard in the database (`pg_advisory_xact_lock(hashtext(sessionId))` around attribution writes).

**Resolution:** a pure function in `packages/core` (client-safe), `personAt(attributions, speakerId, ms)`, returns the current attribution that covers that voice at that time. A ranged row beats a whole-session row, a confirmed row beats a proposed one, and `human` beats everything. Every screen uses it, so there is one rule. A moment's people are the persons resolved over the moment's words, so focus stays an in-memory filter (concept spec §6.3).

### 5.3 `session_records`
- `session_id`, `chamber` (`senado` | `camara`), `ref` (the URL or ids the journalist gave)
- `fetched_at`, `raw_key` (the fetched JSON, kept in storage for evidence and re-runs)
- `status`: `pending` | `matched` | `failed` (with a friendly error)

Fetches run in a job (`session.names`, §6.2), and the row is job-owned, so it goes in the sweep (R32).

## 6. Pipeline

### 6.1 The `name_speakers` node
- **Position:** after the context check (`understand_context` / `ask_context`), before `index`. Caption names therefore show in Who's who after the check, not during it. **[decided: a new node; owner decided 2026-11-03: after the context check, so trial sessions never send frames; caption names show in Who's who after the check]**
- **Steps** (each a source that can fail alone and logs, like the moment passes):
  1. **Record** (§7.4), if a record is linked.
  2. **Captions** (§7.3), if the session has video (not audio-only) and the original is still there.
  3. **Transcript and metadata:** after `understand_context`, the context agent's `participants[].name` facts that survive grounding become `proposed` attributions with source `transcript` (from `video`) or `metadata`. This is a small change to the context agent: its output feeds attributions instead of being the store of names. **[my call]**
- **One rule decides the pause.** `assessSufficiency` asks about a voice when the voice has more than `MIN_SPEAKER_SHARE` of the words and no attribution, or only a low-confidence one. The Who's who panel shows every voice above that share, plus the rest behind "Show N more voices". **[my call]**
- **The context card's `participants`** become a projection of the current attributions for prompts: confirmed names as facts, proposed ones as "probably". Human `cardEdits` for participants are replaced by Who's who actions, which write attributions. Prompts that list names say which are confirmed. **[my call]**
- **Re-runs:**
  - The node re-runs on resume only when the journalist added or changed the record link at the pause.
  - It is idempotent: it supersedes only its own earlier AI rows, never human rows (pgboss-langgraph gotcha 4: every node must be safe to run twice).
- **Stages:** a new `naming_speakers` stage between `awaiting_context` and `indexing`, with progress 60 and the label "Naming speakers". **[decided: the stage exists; owner decided 2026-11-03: after the context check, so trial sessions never send frames; caption names show in Who's who after the check]**

### 6.2 After the analysis (on demand)
- **Who's who edits** after analysis are plain API writes; no job, no AI.
- **Linking a record after analysis** (from the panel):
  - It enqueues `session.names`, which runs the record step only. The DB claims it first, then sends the job (the repo rule for queues).
  - New record names become attributions. They change names on screen, but never moments or the briefing (§8.4).
- **`moment.find_more`** (§8.3): a new queue with `JOB_OPTIONS`. It claims a `find_more_requests` row (`pending` → `running` → `done` | `failed`). The row belongs in the sweep.

### 6.3 Diarization limits
- **The problem:** one voice id can be two people (two deputies with similar voices merged), and one person can be two voice ids.
- **What Plan 3 does:**
  - **Record matching works on turns, not voices.** It may name turn 12 of voice "D" as Senator X and turn 31 of voice "D" as Senator Y, and writes ranged attributions.
  - **Who's who lists persons and unnamed voices,** not raw ids. A voice whose turns resolve to several persons shows as those persons, each with their turns' total speaking time.
  - **Merging and splitting voices by hand is out of scope.** The journalist can rename a turn range from the moment row (§8.1), which covers the common case. **[my call]**
- **Builder check before building §7.4:**
  - Measure diarization on one real Senado session: how many voice ids, and how often one voice spans several record speakers.
  - Try AssemblyAI's speaker-count options (`speakers_expected` or a range) when a record gives the speaker count **[unverified: exact parameter names and limits]**.

## 7. Name sources

### 7.1 Order and conflicts
Each source writes its own rows; resolution (§5.2) decides what shows, in this order: `human` > `record` (confirmed) > `caption` > `transcript` > `metadata`. When two AI sources disagree on a voice, both rows stay `proposed`. Who's who shows the conflict ("Caption says X, transcript says Y"), and the voice displays as "Speaker C" until a human decides. **[my call: disagreement shows as unnamed, because wrong is worse than unnamed]**

### 7.2 Transcript and metadata (exists; re-wired)
These are the context agent's grounded `participants` names. They stay `proposed`, so the debate's names need one human confirmation each. Who's who offers "Confirm all proposed" for the case where everything is right. **[my call]**

### 7.3 On-screen captions
- **Frames:**
  - For each voice, take up to 3 turns of at least 8 s, preferring the voice's first turns. Grab frames at +1 s and +4 s into each turn, from the original video, scaled to 1280 px wide.
  - Captions (lower thirds) usually appear as a speaker starts.
  - This gives at most 6 frames per voice and 60 per session, longest-speaking voices first. **[my call; builder tunes]**
- **Read:**
  - One vision call per frame on the `fast` model returns `{ captionText | null, personName | null, partyOrRole | null }`.
  - The output schema is lenient and validated in code (`llm-structured-output`). "Read only text visible in the image; never guess."
  - `StructuredLLM` gains an optional image input. Both adapters, Anthropic and OpenRouter, need it, and the fake must accept it too.
  - **[unverified]:** the image format each provider accepts through LangChain and OpenRouter. Record a real response (vendor-contract-check skill) before writing the fake.
- **Match:**
  - A name read from a caption must appear in at least 2 frames of the same voice, with no other name read for that voice.
  - It is then matched to `persons`: exact normalised match, or an official member found through the chamber registry search when the profile is `parliament` **[unverified: registry name search]**. If neither matches, a new custom person is created.
  - The result is a `caption` attribution, always `proposed`, with confidence from the frame agreement. Evidence keeps the frame (stored under `<sessionId>/names/<frame>.jpg`) and the text read, so Who's who can show the frame next to the name.
- **Sensitive profiles skip captions:** a session whose final profile (the context card's, after the context check) is sensitive (`trial`) reads no captions and sends no frame to the AI provider.
- **Cost:** about 60 Haiku image calls, roughly $0.05–0.15 per session **[builder: measure on the debate]**. The session's cost estimate (`packages/core/src/cost.ts`) includes it.
- **Retention:** caption frames are evidence, and they are kept with the analysis. They are small, and the 14-day video rule doesn't apply to them. **[my call]**

### 7.4 Official record (Senado and Câmara)
- **Linking:**
  - The upload form and the Who's who panel get an optional "Official record" field, shown for the `parliament` profile.
  - It accepts a Senado plenary session URL or a date, or a Câmara event URL or id.
  - The builder confirms the URL shapes **[unverified]**.
  - The concept spec makes connectors find the session themselves; that is Plan 4. **[my call]**
- **Senado:**
  - `GET /dadosabertos/plenario/lista/discursos/{ini}/{fim}.json` (**verified live 2026-10-30**) gives each speech's speaker code, name, party, UF, summary, full text and interrupters (`Apartes`), with no per-speech time.
  - Filter to the linked session when the payload carries a session id **[unverified]**, otherwise to the date.
  - Fetch the matched senators from `/senador/{codigo}` and upsert them as official persons.
- **Câmara (built in Task 17; API probed live 2026-11-03 on event 82635, the plenary of 2026-06-30):**
  - Base `https://dadosabertos.camara.leg.br/api/v2`, `Accept: application/json`, no key; every answer is `{ dados, links }`.
  - `GET /eventos/{id}` gives `dataHoraInicio` / `dataHoraFim` (`2026-06-30T13:55`, Brasília time without zone; the end can be null). An unknown id answers 404.
  - `GET /eventos/{id}/deputados` lists the event's deputies (id, name, party, UF, photo): 494 on that plenary.
  - `GET /eventos/{id}/discursos` answers 405: **there is no per-event speech list**.
  - `GET /deputados/{id}/discursos?dataInicio&dataFim&itens=100` gives a deputy's speeches (`dataHoraInicio` to the minute, full `transcricao` starting "O SR. NAME (PL - DF. Pela ordem. Sem revisão do orador.) - ", `sumario`). Its `uriEvento` is empty: a speech doesn't say which event it belongs to.
  - **Window rule:** the session's speech list is every event deputy's speeches of the event's date whose `dataHoraInicio` falls inside the window. The stamps are **4-minute stenography blocks** (on the probe all 126 spoken speeches sit on minutes divisible by 4; only the 7 texts handed to the Mesa use the exact start minute), so the window starts at the block that contains the event's start and ends at `dataHoraFim` (or the end of that day when there is none), the end inclusive. Order: stamp, then deputy id; speeches sharing a stamp (34 of 77 stamps held 2 to 4) have no known order, so before the monotonic alignment each run of equal stamps is reordered by the index of its best-matching turn (`tieOrder`). A speech with neither `transcricao` nor `sumario` is dropped; with only `sumario` it is a `summary` speech (proposals only).
  - Only plenary events (`orgaos` has `PLEN`) that have ended (`situacao` starts with "Encerrada") are accepted: "Only Câmara plenary sessions are supported." / "The Câmara record of this session isn't complete yet. Try again later." Both fail at once, before any deputy call.
  - Cost: 2 calls plus one per event deputy (~500 on a plenary), 4 at a time, under 3 minutes, no errors on the probe (133 speeches by 60 deputies). The person fields (name, party, UF, photo) come from the event's list, so there is no per-deputy fetch. A deputy call that keeps failing after one retry fails the run (the job retries) rather than naming from a partial list.
  - A 404 on the event, or no speech in the window, is "The Câmara has no speeches for that session."
- **Matching (deterministic, no LLM):**
  - Split the transcript into turns. Compare each turn's text with each record speech's text, using normalised Portuguese tokens and TF-IDF cosine similarity.
  - Align the turns and speeches in order with dynamic programming: speeches keep their order, a turn may match no speech (an aparte, the chair, noise), and a long speech may span consecutive turns.
  - A matched turn gets a ranged `record` attribution: `confirmed` when its similarity ≥ `RECORD_CONFIRM` and `proposed` between `RECORD_PROPOSE` and that.
  - The defaults are tuned on one real session so that wrong names stay under 1% of speaking time. **[builder: thresholds; my call: the target]**
  - The chair ("Presidente") is named like anyone else when the record names them. **[decided]**
- **Re-use:** the raw record stays in storage (`raw_key`). A later re-run (Plan 4's re-versioning) can then reuse it, and evidence can cite it.

## 8. Screens

The `digestor-ui` skill applies to all of this (tokens, copy, keyboard, a11y, `lang` and `dir="auto"` on names).

### 8.1 Names everywhere
- **The name and badge:**
  - A shared `SpeakerName` component shows the resolved name with a small source badge, and a dotted underline when the name is `proposed`.
  - "Speaker C" shows for a voice that is unnamed, `anonymous`, in conflict, or under the sensitive rule.
  - Hovering or focusing the badge says the source and the evidence in one line ("From the Senado record of 4 Nov: speech 12, 0.91 match").
- **Where names appear:**
  - Preview header (*N speakers · M named*), Timeline tooltips, top highlight cards, briefing highlights, Full briefing rows, Prepare and Export lists, the Ask drawer.
  - Clicking a name opens a small popover with *Confirm*, *Change…* (a person picker with search and "New person"), *No name*, and *Only this part*. *Only this part* applies the change to the moment's range only, as a ranged human attribution.
  - The popover is keyboard reachable; Escape closes it. **[my call]**
- **Not in subtitles or burned video.** Speaker names never go into subtitle cues. **[my call]**

### 8.2 Who's who panel
- **In the context check:**
  - It replaces today's participant fields. Each row has: a ▶ sample (from the voice's first long turn, played from the proxy as today), the proposed name, the source badge, its role, party and state when known, evidence (the caption frame thumbnail, the record match, the quote), and *Confirm* / *Change* / *No name*.
  - Above the rows sit "Confirm all proposed" and, for `parliament`, the "Official record" field.
  - Continue and Skip work as today. Unnamed voices simply stay unnamed. **[decided: panel; my call: layout]**
- **After analysis:**
  - The same panel opens as a drawer from the Preview header's speaker count and from "Who's who" in the Full briefing.
  - Changes apply instantly on screen. No AI call runs and nothing is re-cut.
- **Sensitive profiles:** the panel shows a one-line reminder: AI-proposed names stay hidden outside this panel until you confirm them. **[decided: anti-goal 8]**

### 8.3 Focus by person and Find more
- **The picker** lists persons (by speaking share) and unnamed voices ("Speaker C"). The URL keeps `s=` for a voice and adds `p=<personId>` for a person. An unknown value falls back to everyone, as today.
- **The filter:** a moment passes when the person resolves for at least `FOCUS_MIN_MS` (3 s) of its words. That leaves out a one-word interjection. **[my call]**
- **"Find more moments with <name>":**
  - The button shows under the list when the focused person has fewer than 5 moments at the selected granularity, and also always in the picker's menu.
  - Clicking it starts `moment.find_more`: one text-only call on the `reasoning` model over that person's turns (and the 30 s around each), capped at about 40k tokens of transcript. It asks for moments at all three granularities, using the same rubric, caps, snapping and normalisation as `findMoments`.
  - Results are personal moments with a new `origin` `find_more`, `owner_id` = owner, in the current analysis version. They show with a "Found for you" marker and the **AI** badge, and never change the official analysis.
  - While it runs, the button shows "Finding…". On failure it shows the friendly error inline, and on "nothing new" it says so.
  - One run per person per analysis version; asking again replaces that person's earlier find-more moments. **[decided: the button, text-only, personal layer; my call: thresholds, model, the replace rule]**

### 8.4 Names changed after the AI wrote its text
Moment titles, "Why:" text and the briefing were written by the model with the names it had then, for example "Lula diz ter percorrido 91 mil quilômetros".
- **The notice:** when `names_at` is older than the newest human or record attribution change, the Preview and Full briefing show "Names changed after this analysis was written. AI text may use earlier names." with **Re-analyse** (the existing explicit, paid re-run).
- **No silent rewrite.** Nothing is rewritten silently (anti-goal 7). Structured fields (speaker names on rows) always show the current names. **[my call]**

### 8.5 Export checklist: `speaker`
- **Rule:** a new `ChecklistId` `speaker` is ok when every voice with at least `FOCUS_MIN_MS` of words inside the clip's current bounds resolves to a `confirmed` or `anonymous` attribution.
- **Failing state:**
  - It names who is missing ("Speaker C is not confirmed"), with *Confirm names* opening the popover.
  - It doesn't need `warningsAck` and can't be acknowledged away: the only ways through are confirming a name or choosing *No name*. **[decided]**
- **Bounds:** it is computed from the clip's bounds, not the moment's, so a trim that pulls in a new voice re-opens the item. It lives in `exportChecklist` (`packages/core`), tested like the other items.

### 8.6 Ask
- Ask's "known participants" comes from the current attributions, with status.
- A new in-session tool, `list_speeches(person)`, returns that person's turns (times, lengths, the topic each falls in), so "When did Flávio speak about debt?" works.
- Tool output that carries transcript text goes through `evidence()` (R31).
- Ask cannot change attributions (concept spec: Ask acts only on the personal layer, and names are not personal). **[my call]**

### 8.7 Report a problem
Attributions get *Report a problem* like moments do: a wrong name, a missed name, or a wrong record match. **[decided]**

## 9. Evaluation (concept spec §14a)

- **Golden format:** the golden file gains `speakers`, a list of `{ startMs, endMs, person: "Luiz Inácio Lula da Silva" | null }` spans. `null` means the golden can't say, and those spans are left out of the scores.
- **The metric,** in `src/eval/metrics.ts`: per transcript word inside a labelled span, compare the golden person with the resolved current attribution, by normalised name. It reports the share of speaking time:
  - **correct:** the right name, confirmed or proposed, counted separately;
  - **wrong:** a different name;
  - **unnamed.**

  It also reports a score: `correct − 5 × wrong`. **[decided: wrong far worse; my call: ×5]**
- **Modes:** `eval.ts` prints the metric twice. Once "before human" counts only AI rows, which is what the AI alone got right. Once "as stored" includes human confirmations. **[my call]**
- **Golden sets:**
  - The Globo debate: the speakers come from the diarization, checked against the transcript. Claude drafts the labels and the owner reviews them, as with the moments.
  - One Senado plenary session. It is the real test of §7.4. Full labels take the owner about 2 h. Until they exist, a sample of 30 turns stands in: the builder labels them from the record and the video, and the owner reviews them. **[my call]**
- **Results** go in the README Evaluation section, as before.

## 10. Testing and vendor contracts

- Record a real vision response (a frame from the debate) and real Senado `discursos` and `senador` payloads before writing fakes (vendor-contract-check skill). Store them under `apps/worker/test/fixtures/`.
- Record matching is pure code: unit tests use a recorded Senado payload and a synthetic transcript built from its texts (order changes, missing speeches, apartes, merged voices).
- `personAt` and the `speaker` checklist item are pure functions in `packages/core` with full unit tests.
- Graph tests follow the gotchas skill: run `name_speakers` twice (idempotent), resume with a new record link, and crash and resume.
- UI: drive with the `digestor-run` skill at 1280 and 390 px: Who's who in the context check, the name popover, focus by person, Find more, and an export blocked and then unblocked.

## 11. Cost

| Work | When | Rough cost |
|---|---|---|
| Caption reading | once per session (`name_speakers`) | about $0.05–0.15 (≤ 60 image calls, `fast`) |
| Record fetch and match | once per linked record | API calls only, no LLM |
| Find more | per click | one `reasoning` call, ≤ 40k tokens, about $0.03 on Haiku |

Nothing in Plan 3 re-runs transcription or the moment passes.

## 12. Delivery order

Each slice ships something usable. **[my call]**

1. **Names everywhere from what we have:**
   - The `persons` and `attributions` tables, and `personAt`.
   - The context agent's names imported as `proposed` attributions.
   - `SpeakerName` with badges and the popover.
   - Who's who in the context check and as a drawer.
   - The `speaker` checklist item and the §8.4 notice.
   - The sensitive-profile rule, and the debate's speakers in the golden file with the attribution metric.
   - After this slice, the debate shows Tralli, Flávio and Lula, confirmed in three clicks.
2. **Focus by person and Find more** (`moment.find_more`, sweep entry).
3. **Captions:** image input for `StructuredLLM` (both adapters and the fake), frames, the vision call, matching, evidence frames, cost.
4. **Senado record:** linking, fetch (a job and the sweep), turn alignment, official persons, thresholds tuned on a real session, diarization check (§6.3), the Senado golden sample.
5. **Câmara record** if §7.4's endpoint check succeeds; otherwise a recorded "not yet" and a note for Plan 4.
6. **Ask** `list_speeches`, Report a problem on attributions, the README results.

## 13. Risks

| Risk | Mitigation |
|---|---|
| A wrong name reaches an export | Only `record` above threshold or a human confirms; disagreements show as "Speaker C"; the `speaker` checklist item can't be acknowledged away; the eval weights wrong ×5 |
| Diarization merges deputies | Record matching works per turn; ranged attributions; a measurement on a real session before tuning (§6.3) |
| Senado or Câmara payloads differ from the research | Every unverified item is flagged; real calls and recorded fixtures come first; Câmara can drop to Plan 4 |
| Captions misread, or a name appears on screen while someone else speaks (a reporter naming a guest, a split screen) | 2-frame agreement per voice, never auto-confirmed, the frame shown as evidence |
| Stale names in AI text | The §8.4 notice and an explicit re-analysis |
| Persons duplicate ("Lula" vs. the full name) | Close-match suggestions before creating a custom person; official ids are unique |

## 14. Calls made in this design, for the owner to check

1. Attributions are the one place names live, at session level with history, not per analysis version (§5.2).
2. The context agent's transcript and metadata names become `proposed` attributions with *from transcript* and *from video details* badges (§4, §7.2).
3. Disagreeing AI sources show as "Speaker C" until a human decides (§7.1).
4. Focus means "speaks in the moment"; "addressed" is deferred (§3).
5. The journalist links the official record by hand in Plan 3 (§7.4).
6. Câmara record naming may slip to Plan 4 if no per-session endpoint works (§7.4).
7. Caption frames are kept as evidence beyond 14 days (§7.3).
8. Names never go into subtitles (§8.1).
9. Find more: shown below 5 moments, one `reasoning` call, results replace that person's earlier ones (§8.3).
10. AI text isn't rewritten when names change; a notice offers re-analysis (§8.4).
11. Ask can read names but not change them (§8.6).
12. Wrong names weigh ×5 in the eval score (§9).
13. Delivery order, names first (§12).

## 15. Left to the builder

- Exact thresholds (`RECORD_CONFIRM`, `RECORD_PROPOSE`, caption agreement, `FOCUS_MIN_MS`) within the stated targets.
- Frame timing and count, and the image size and format per provider.
- The text-similarity details for Portuguese (stemming, stop words).
- The migration that moves the existing human participant edits into attributions (dev data may be wiped, as before).
- Exact URL shapes for record links, after checking them live.
- Styling within the `digestor-ui` rules.
