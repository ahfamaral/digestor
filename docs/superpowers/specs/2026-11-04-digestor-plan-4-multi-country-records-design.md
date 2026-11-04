# Digestor Plan 4: Parliaments of several countries (Brazil, Germany, USA)

**Date:** 2026-11-04
**Status:** Approved by owner 2026-11-04, with every [my call] as written (builder check done; its five questions settled as [my call], §13 items 11–14)
**Builds on:** `2026-11-02-digestor-plan-3-speaker-names-design.md` (Plan 3, especially §7.4 "Official record"). Where this document and Plan 3 disagree, this document wins for Plan 4.

Legend:
- **[decided]**: the owner decided it in the design conversation of 2026-11-04.
- **[my call]**: a default chosen while writing; the owner can override it (all are listed again in §13).
- **[builder]**: left to the builder.
- **[unverified]**: an external fact that must be checked with real requests before code depends on it.

Research notes, with what was verified live on 2026-11-04: `.superpowers/research/2026-11-04-parliament-sources.md` (git-ignored scratch; the facts that matter are copied below).

---

## 1. Intent

Digestor names the speakers of a Brazilian plenary video from the official record (Plan 3). The owner wants the product to work for other countries before building anything on top of it. The next two are **Germany (Bundestag)** and the **USA (House and Senate)**. **[decided]**

The larger roadmap, agreed in the same conversation, puts Plan 4 first:

1. **Plan 4 (this document):**
   - Turn "Câmara or Senado" into "a country with houses", with Brazil working exactly as today.
   - Give the Bundestag, the US House and the US Senate the same speaker naming Brazil has.
2. **Plan 5: the Tracker**, built once for all three countries. **[decided]**
   - Every member of every house, with search.
   - Their mandates across terms and elections.
   - Their official record: attendance, bills and amendments authored, and votes.
   - What your sessions add: speaking time and themes.
   - The current term by default, earlier terms for comparison, and a date filter.
3. **Later:**
   - election data per country (TSE in Brazil, the federal returning officer in Germany, US results), showing who continues, who leaves and who arrives;
   - "football-style" comparison and stats screens;
   - judgement metrics (tributes, offences) as new moment types;
   - a heat map of the words a politician uses;
   - committee hearings.

Plan 4 must not box Plan 5 in (§8).

**Success looks like this:**
- A Bundestag floor debate from YouTube shows each speaker's real name from the Plenarprotokoll. The journalist confirms Digestor's suggestion of which sitting it is in one click, and the speakers need no other step.
- A US House floor video, linked by its date, gets names from the Congressional Record.
- Every Brazilian path works as on `main` today: the same links accepted, the same names, the same evaluation scores.

## 2. Where we start (state of `main` at c625958)

- **Data:**
  - `RecordRef` (`packages/core/src/recordRef.ts`) is a two-way union: `{ chamber: "senado"; date; sessionCode | null; url }` | `{ chamber: "camara"; eventId; url }`.
  - `parseRecordRef` reads one text field. A plain date means the Senado.
  - `session_records.chamber` is `"senado" | "camara"`.
  - `persons.official_ids` is a JSON map keyed `senado` / `camara`, with one unique index per key. A person also has a single `party` and `state`.
- **Worker, `apps/worker/src/records/`:**
  - `senado.ts` and `camara.ts` hold the fetchers.
  - `RecordSpeech` lives in `senado.ts`.
  - `align.ts` does the matching: TF-IDF cosine with **Portuguese** stop words, Brazilian header and markup stripping (`speechText`, `stripRecordMarkup`), monotonic DP, `tieOrder`, and `RECORD_CONFIRM` 0.6 / `RECORD_PROPOSE` 0.35 tuned on the Senado.
  - `pipeline/naming.ts` `runClaimed` branches on `ref.chamber` for:
    - fetching the speeches;
    - building the person fields;
    - writing the error lines ("The Senado has no speeches for that date.", `recordNoMatch`, `recordFetchFailed`).
  - `stripTitle` there knows only Portuguese titles.
- **Web:**
  - The "Official record" field on the upload form and in the Who's who panel (`RecordLink.tsx`, `lib/recordInput.ts`) takes free text, explained by `messages/en.ts` `upload.recordHelp`.
- **YouTube:**
  - The worker's yt-dlp step keeps `title`, `description` (4000 chars), `channel` and `uploadDate` (`youtube/ytdlp.ts` `YouTubeMetadata`).
  - YouTube is the only link source (`sessions.source` is `upload` | `youtube`).
- **What carries over unchanged:** the analysis prompts (the `parliament` profile is country-neutral) and the clip, subtitle and export flow.

## 3. Goals, non-goals, anti-goals

### Goals
1. **A house registry.** Brazil — Câmara, Senado; Germany — Bundestag; USA — House, Senate. Each house is one connector with the same jobs (§5). **[decided]**
2. **Brazil moves onto the registry with no visible change**, apart from the new way to pick a house in the record field (§6). Its tests and the Senado evaluation must give the same results. **[decided]**
3. **Bundestag naming** from the Plenarprotokoll XML. **[decided]**
4. **US House and US Senate naming** from the Congressional Record. **[decided]**
5. **Linking a video to its sitting**, three ways **[decided]**:
   - a YouTube link from which Digestor suggests the house and sitting, for the journalist to confirm;
   - a house plus a date, which must always work;
   - an official link.
6. **"Not published yet" is a waiting state, not a failure:**
   - the journalist sees a plain line;
   - Digestor tries again by itself (§7).
7. **Floor debates only.** **[decided]**

### Non-goals (Plan 4)
- Committee hearings (later). **[decided]**
- Anything from the Tracker:
  - a member registry with mandates;
  - attendance, bills and votes;
  - party history;
  - photos fetched beyond what the record step gets today.
- Election data, stats, judgement metrics, the word heat map. **[decided]**
- Germany's Bundesrat. Its records are PDF or HTML with no open XML, and its speakers are Länder ministers, so it's of low value now. **[my call]**
- Interviews and other profiles: nothing in Plan 4 touches them. The country-and-house concept belongs to parliament sessions only. **[decided: "the interview analyst should clearly be separated"]**
- A UI translated into German or Portuguese. The UI stays English, while subtitles and briefings already follow the video's language (below).

### Anti-goals (hard rules)
- **Never a wrong name** (Plan 3's anti-goal 1). A connector that can't tell who spoke leaves the turn unnamed. Thresholds for a new house are tuned on a real video of that house before its names can be `confirmed` (§10).
- **Brazil must not regress.** No change to Câmara or Senado matching results, links that work today, or stored data.
- **No silent scraping failure.** Where a connector reads an HTML or AJAX page (the Bundestag listing), a changed page gives a friendly line and a log entry naming the page. It never yields an empty or wrong record.
- **No paid calls without the owner's approval.** The real-video evaluations (§10) need a "spend approved".
- **No ffmpeg or yt-dlp on the host**, as always.

## 4. Concepts

- **Country:** `BR`, `DE`, `US` (ISO 3166 alpha-2).
- **House** (code: `chamber`, kept for continuity): one legislative body with an official speech record. Ids: `camara`, `senado`, `bundestag`, `us_house`, `us_senate`.
  - The two Brazilian ids stay as they are, because they are stored in `session_records` and in attribution evidence. **[my call]**
- **Id system:** whose permanent person id a house uses. The ids are `camara`, `senado`, `bundestag` (MdB id) and `bioguide`. **US House and US Senate share `bioguide`**, so a representative who becomes a senator is already one person. `persons.official_ids` is keyed by id system, not by house. **[my call]**
- **Sitting:** one meeting of a house that has its own record. A **sitting day** is a house plus a date. A date covers every sitting of that house on that day (§6.2).
- **Connector:** the code for one house (§5).

## 5. The house registry and connectors

### 5.1 Registry (client-safe, `packages/core`)

One table of houses. Each entry has:
- `id`, `country`;
- `name` ("Câmara dos Deputados", "Bundestag", "U.S. House of Representatives", …) and `shortName` ("Câmara", "Bundestag", "House", "Senate");
- `idSystem`;
- `defaultLanguage` (`pt`, `de`, `en`);
- `publishWindowDays` (§7);
- `titles`: the honorifics stripped from names, e.g. "Abg.", "Präsident", "Bundesminister" for the Bundestag and "Mr.", "Mrs.", "Ms.", "Rep.", "Sen.", "Speaker" for the US.

The web and the worker both read this table for labels and rules, which replaces the scattered `chamber === "camara"` branches. **[my call; builder: the exact shape]**

`RecordRef` stays a union discriminated by `chamber`. **[my call]**
- The two existing variants stay byte-for-byte, so stored refs still parse.
- New variants:
  - `{ chamber: "camara"; date: string; url }` (a Câmara sitting day; the event-id form stays);
  - `{ chamber: "bundestag"; period: number; sitting: number | null; date: string | null; url }` (at least one of `sitting` and `date`);
  - `{ chamber: "us_house" | "us_senate"; date: string; url }`.

### 5.2 Connector interface (worker, `apps/worker/src/records/`)

Each house implements:

```ts
interface RecordConnector {
  chamber: ChamberId;
  /** The ordered speeches of the ref's sitting or sitting day, plus what the record says about each speaker. */
  fetchRecord(ref: RecordRef, f: typeof fetch): Promise<{ speeches: RecordSpeech[]; date: string; members: Record<string, MemberInfo> }>;
  /** Text of one speech as its own speaker said it (the house's markup, headers and interjections removed). */
  speechText(speech: RecordSpeech): string;
  /** Lower-case stop words for the matcher in this house's language. */
  stopWords: ReadonlySet<string>;
}
```

- `MemberInfo` holds `displayName`, `fullName?`, `party?`, `state?` and `photoUrl?`.
- A connector throws three error kinds:
  - `RecordNotFoundError` (deterministic) carries the friendly line;
  - **new** `RecordNotPublishedError` (§7) means the record may not be published yet;
  - anything else is transient (retry).
- `RecordSpeech` moves out of `senado.ts` into a shared file.
- `officialId` may be `null` for a speech whose speaker the record can't identify, such as a presiding officer without an id. Such speeches still take part in the alignment, so the chair's turns don't get pushed onto a member. They never produce an attribution. **[my call]**

`naming.ts` `runClaimed` becomes connector-driven: it looks up the connector by `ref.chamber`, and the error lines take the house's `shortName` and the date. The Senado's two-step senator fetch (`fetchSenador`) moves inside the Senado connector's `members`.

`align.ts` keeps the algorithm and takes the connector's `speechText` and `stopWords`. The current Portuguese list and `speechText` become the Brazilian connectors' versions, unchanged.

Thresholds:
- `RECORD_CONFIRM` / `RECORD_PROPOSE` become per-house values in the registry, starting at 0.6 / 0.35.
- For a house not yet evaluated on a real video (§10), **every name is `proposed` only**: `confirm` is set above 1. **[my call]**

### 5.3 Brazil (move, plus one addition)

- **Senado:** unchanged behaviour.
- **Câmara:**
  - Unchanged for an event link or id.
  - **New: a date.**
    - Find that day's plenary events (`GET /eventos?dataInicio=D&dataFim=D`, filtered to `PLEN` and `situacao` starting "Encerrada") **[unverified: the filter parameters]**.
    - Run today's per-event fetch for each.
    - Concatenate the speeches in time order.
    - Rule out an event that hasn't ended as today.
    - No ended plenary that day → `RecordNotFoundError("The Câmara has no plenary session on that date.")`.

### 5.4 Bundestag

All facts below were verified live on 2026-11-04 unless marked.

- **Record:** the Plenarprotokoll XML, one file per sitting, e.g. `https://www.bundestag.de/resource/blob/1225450/21103.xml` (period 21, sitting 103, 16.10.2026, 63 `<rede>` elements).
  - The root carries `wahlperiode`, `sitzung-nr`, `sitzung-datum` (DD.MM.YYYY), and the start and end times.
- **Finding the file:** the blob number can't be derived from the sitting number, so the connector reads the open-data listing for the electoral period. That's the AJAX fragment `https://www.bundestag.de/ajax/filterlist/de/services/opendata/1058442-1058442?limit=…&noFilterSet=true` for period 21 (`866354-866354` for 20). It matches by sitting number or by date.
  - The connector checks the file's root attributes against the ref.
  - A listing it can't parse is a transient error with a log line naming the URL (anti-goal: no silent scraping failure).
  - The DIP API (`search.dip.bundestag.de/api/v1`) needs a key. If the env var `BUNDESTAG_DIP_API_KEY` is set, it is the fallback lookup **[my call]**. A missing key is not an error.
- **Speeches:** one per `<rede>`.
  - The speaker is `<redner id="…">`, the MdB id that `MdB-Stammdaten` also uses (verified).
  - The name comes from `<vorname>`/`<nachname>`, the party from `<fraktion>`, or the role for ministers and presidents.
  - `<kommentar>` elements (applause, heckles) are dropped from the text.
  - Paragraphs inside a `<rede>` spoken by someone else (the president's interventions, introduced by their own `<name>` line) are split out as separate speeches, in order. A paragraph with no resolvable id gets `officialId: null`.
  - **[unverified: the exact markup of the president's lines]**
  - No timestamps; order is document order.
- **Members:** only what the protocol gives (name, fraktion). No state or constituency until Plan 5's registry reads `MdB-Stammdaten`. **[my call]**
- **Lag:** unmeasured. The sitting of 16.10 was online by 04.11, and the final protocol is said to take days to about two weeks **[unverified]**. `publishWindowDays` is 21 **[my call]**. The builder measures the lag on a sitting held during the build and records it.
  - *Note 2026-11-04 (Task 7):* not yet measurable. The newest sitting in the WP21 listing is no. 103 of 16.10.2026 (listed on 04.11, 19 days later); sittings 101 to 103 (14.-16.10) are all listed, so the lag is at most 19 days. The next sitting (no. 104) is today, 04.11.2026 at 14:00 CET, so its XML can't be timed yet. The listing and XML carry no publication time (the XML has no last-modified header); the builder re-checks the listing for no. 104 after the sitting. Until then 21 days stays.
- **A sitting number with no date** (`21/104`) that isn't in the listing:
  - if it is newer than the last listed sitting of that period, it is "not published yet", and the window is counted from the day it was first linked;
  - otherwise it is not found. **[my call]**

### 5.5 US House and US Senate

- **Record:** the Congressional Record daily edition on GovInfo, one package per day, `CREC-YYYY-MM-DD`, covering both chambers.
  - `GET https://api.govinfo.gov/packages/CREC-…/granules` lists granules: one per debate item, not per speech. `granuleClass` is HOUSE, SENATE, EXTENSIONS or DAILYDIGEST.
  - The connector keeps only its own chamber's class. Extensions of Remarks and the Digest are never spoken.
  - The order is by page (`PgH2790`, …), then position. **[builder: confirm the granule order]**
- **Speeches:** parsed from each granule's text (`/htm`).
  - A new speaker starts a line with a label: `  Mr. NADLER.`, `  Ms. JOHNSON of Texas.`, `  The SPEAKER pro tempore.`, `  The PRESIDING OFFICER.`, `  The CLERK.`
  - `[[Page H2791]]` markers and `{time} 1315` lines are removed. A `{time}` marker may become the coarse `at` stamp **[builder]**.
- **Speaker ids:** the granule's MODS (`/mods`) lists `congMember bioGuideId party state` with a `parsed` name ("Mr. NADLER"). A label maps to an id only by an **exact match with a `parsed` name in the same granule** (verified).
  - Presiding-officer, Clerk and other role labels get `officialId: null`.
  - A label that matches none, or more than one, `congMember` also gets `null`. Never a guess.
- **Members:** party and state come from MODS. Photos are left out in Plan 4 **[my call]**.
- **Key:**
  - The env var `API_DATA_GOV_KEY` holds a free api.data.gov key.
  - When missing, the step fails with the usual line "`API_DATA_GOV_KEY` is not set on the server."
  - `DEMO_KEY` allows about 10 requests, too few for one day.
  - Requests run 4 at a time.
  - The builder may use the package `zip` or package-level MODS to cut the request count **[builder]**.
- **Lag:** the next morning, US time (verified from `lastModified`). `publishWindowDays` is 3 **[my call]**.
- **Re-publication:** the daily edition can change later. A re-run fetches it again; nothing is cached across runs except the stored raw record (as in Plan 3).

## 6. Linking a video to its sitting

### 6.1 The record field (upload form and Who's who panel)

- The free-text field becomes **a house select plus one text box**. **[decided: house plus date; my call: the layout]**
- The select lists the five houses grouped by country, plus "Detect from the link".
  - It defaults to "Detect from the link" when the text box holds a link, and otherwise to the last house used in this browser (stored locally).
- The text box takes, depending on the house:

| House | Date | Other |
|---|---|---|
| Senado | yes (all sessions of the day, as today) | session link + date (as today) |
| Câmara | **yes (new, §5.3)** | event link or id (as today) |
| Bundestag | yes | `21/103` (period/sitting) |
| House, Senate | yes | — |

- Dates are accepted as `YYYY-MM-DD` and `DD/MM/YYYY` (as today), plus `MM/DD/YYYY` **only** when a US house is selected **[my call]**.
- A Brazilian link pasted with any house selected still parses as today. The link wins over the select.
- The API takes `record` (text) plus an optional `chamber`. Without `chamber`, the text is parsed exactly as today, so existing callers and tests keep working. **[my call]**
- Official video links:
  - A Bundestag Mediathek link (`bundestag.de/mediathek/video?videoid=…`) is accepted **as a record link only if** the builder finds a stable way to read its sitting **[unverified]**. Otherwise it is rejected with "Paste the date or sitting number instead."
  - US floor-video links carry no sitting id and are not record links.

### 6.2 More than one sitting on a date

A date means **every sitting of that house on that day**, in time order. The matcher already skips speeches no turn matches, so the video picks out its own sitting. **[my call]**

This replaces the "pick one from a list" step I described in the conversation: it needs no extra round trip, and it is how the Senado already behaves. If a real multi-sitting day matches badly in evaluation, a picker comes back as a follow-up.

### 6.3 Suggestion from a YouTube video **[decided: suggest, the journalist confirms]**

- **When:** after the download, if the session has no linked record. The worker runs a deterministic suggester **with no LLM call** **[my call]** over `title`, `description`, `channel` and `uploadDate`.
- **Target:** full sittings **and** single speeches or debates cut from them. The matcher aligns a short video to a slice of the sitting's speeches, so both work. **[my call]**
- **Rules per house** (patterns live in the registry; the builder confirms them on real titles from each house's channels **[unverified]**). A suggestion needs a **house** and a **date or sitting number**:
  - **The house comes from the channel**, in one of two ways:
    - **The parliament's own channel** is enough on its own. These are Deutscher Bundestag, TV Câmara / Câmara dos Deputados, TV Senado, and the official House and Senate channels.
    - **A broadcaster channel** also needs a sitting word in the title or description. The broadcasters are phoenix for the Bundestag and C-SPAN for the US. The sitting words are "Sitzung", "Plenarsitzung", "Bundestag" + "Debatte" or "Rede", "House Floor", "Senate Floor", "House session" and "Senate session". So an interview on phoenix or a C-SPAN hearing gets no suggestion.
  - **The date or sitting number comes from the video text:**
    - a sitting number ("103. Sitzung") or a date in the title, then in the description;
    - `uploadDate` only as the last resort, and only on the parliament's own channel. Broadcasters often upload days later.
- **Profile:** the suggestion is computed and stored after the download, but **shown only while the session's profile is `parliament`**. A suggestion hidden because of the profile comes back if the profile is changed to `parliament`. **[my call]**
- **Source:** only the session's own YouTube source. The record field does not take a YouTube link (a pasted YouTube link answers "Paste the date or the official record link."), so no metadata fetch is added to the web path. **[my call]**
- **Stored as** a `session_records` row with the **new status `suggested`**.
  - The record step only claims `pending` rows, so a suggestion is never fetched before the journalist accepts it.
  - The sweep ignores `suggested` (no job owns it).
- **Shown** at the context check, the session's existing human pause, above the questions:
  - the line: "This looks like the **Bundestag** sitting of **16/10/2026**."
  - the buttons "Use this record" and "Not this one".
  - "Use this record" links it, so the row goes to `pending`.
    - **While the session is paused at the context check, no job is sent.** Instead, the graph gains a second record step **after** the context check and **before** `name_speakers` (`match_record` again; a no-op unless a record is `pending`). The first analysis then already has the record's names, and the journalist needs no other step. **[my call]**
    - A record that isn't published yet goes to `waiting` there (§7), and the analysis continues without it.
    - Outside the pause (Who's who on a ready session), "Use this record" sends `session.names`, the path the "Link record" button already takes.
    - The claim's compare-and-set keeps the graph step and a job from both running it.
  - "Not this one" deletes the suggestion and opens the record field.
  - The same line shows in the Who's who panel while the suggestion is open.
- **If the context check is skipped**, the suggestion stays visible in the Who's who panel.

## 7. Waiting for a record that isn't published yet

- **When a connector reports "not published yet":** it raises `RecordNotPublishedError` when the record for the ref doesn't exist **and** the date lies within the house's `publishWindowDays` of today. Further back, a missing record is `RecordNotFoundError` as today.
- **The waiting row:** status `waiting`, with a new `retry_at` column.
  - Shown as: "The **Bundestag** hasn't published the record of **16/10/2026** yet. Digestor will check again. If there was no sitting that day, check the date."
- **Retries:** a scheduled job (`records.retry`, hourly **[my call]**) claims `waiting` rows whose `retry_at` has passed (compare-and-set `waiting` → `pending`) and sends `session.names`.
  - Retries happen every 6 hours **[my call]**.
  - Once the date leaves the window, the row fails with the not-found line.
- **Sweep:** `waiting` rows aren't job-owned and are left alone. `pending`/`running` keep their R32 rule.
- **Who it applies to:** all houses. The Brazilian houses get `publishWindowDays` 2 **[my call]**. This is the one behaviour change for Brazil, and it only affects a date in the last two days that has no record yet.

## 8. Data model changes (and what Plan 5 can count on)

- **`persons.official_ids`:**
  - Keys become id systems. Existing `camara` and `senado` keys stay valid as they are, since they are id-system names too.
  - New keys: `bundestag` and `bioguide`.
  - Each new key gets a unique index, like the existing two.
  - No data migration.
- **`session_records`:**
  - `chamber` widens to the five ids;
  - `status` gains `suggested` and `waiting`;
  - a nullable `retry_at` is added.
  - Migration `0012_*`.
- **`sessions`:** nothing new. The house and date of a session live on its record ref.
- **For Plan 5 (not built now):**
  - Plan 5 adds a `mandates` table (person, house, term, start/end, party, state or constituency, seat or substitute).
  - It also adds a members sync per house: Câmara `/deputados`, Senado `/senador/lista`, Bundestag `MdB-Stammdaten.zip`, Congress.gov `/member`.
  - Because ids are per id system, those syncs attach to the same persons Plan 4 creates. Plan 4 must not write per-term facts (party, state) anywhere Plan 5 would have to undo. They stay as today's "latest known" fields on `persons`. **[my call]**

## 9. Screens and copy

- **Record field:** the house select and text box (§6.1). The help text below it changes with the selected house, one example per accepted form.
- **Status lines:** today's lines, with the house's `shortName` instead of "Senado"/"Câmara", plus the new `waiting` and `suggested` lines (§6.3, §7).
- **Who's who:**
  - **Person detail line:** party and state where known, then the house **for persons named from a record in this session**.
    - The house comes from the session's linked record. Plan 4's record evidence also stores `chamber` and `date`; older evidence keeps inferring its house from the URL as today.
    - It is not stored on the person, since the house is a per-term fact (§8).
    - Brazilian persons show it too ("PL-ES · Senado"). This one copy change for Brazil is accepted. **[my call]**
  - **Country:** added after the house for a non-Brazilian house, e.g. "SPD · Bundestag (Germany)", "D-NY · House (USA)". **[decided in conversation as my call]**
  - **Evidence line:** "From the Bundestag record of 16/10/2026: speech 12, 0.81 match", generalising `evidenceRecordSenado` / `evidenceRecordCamara`.
- **Default languages:** subtitles and the briefing follow the language spoken in the video, as today. Nothing new is needed. **[my call, told to the owner]**
- Read `.claude/skills/digestor-ui/SKILL.md` before any screen work. Check at 1280 and 390 px.

## 10. Evaluation

- **Brazil:**
  - re-run the Senado golden (`apps/worker/eval/senado-2026-06-30.golden.json`) against the stored transcript, with a free re-fetch of the record. It must give the same table as today (wrong-name rate 0%, score 0.93);
  - all Câmara fixtures and tests pass unchanged.
- **Each new house, on one real floor video:**
  1. a Bundestag sitting from the official YouTube channel;
  2. a US House day.
  The US Senate rides on the House code and is checked on fixtures, plus one real day if cheap.
  - **Steps:** transcribe, write a golden for 30 turns (as in Task 16), tune that house's thresholds, and record the table in the README Evaluation section.
  - **Gate:** until a house has its evaluation, its names are proposals only (§5.2).
  - **Cost:** AssemblyAI about $0.23 per hour plus the analysis at about $0.07 per hour, so about $1 to $2 for both. **Needs the owner's "spend approved".**
  - The video is the owner's pick, or one I propose from the official channels.
- **Câmara real-video evaluation** (parked from Plan 3) can run in the same pass if the owner provides the TV Câmara link.

## 11. Testing and vendor contracts

- Read `.claude/skills/vendor-contract-check/SKILL.md` before writing any fake.
- Fixtures are **recorded live** and trimmed:
  - one Bundestag listing fragment and one Plenarprotokoll XML;
  - one CREC granules list, plus one granule's `htm` and `mods`, for House and for Senate;
  - one Câmara events-by-date answer.
- **Tests per connector:**
  - speeches in order;
  - ids resolved;
  - interjections and page markers dropped;
  - chair and unknown labels give `null`;
  - not found against not published;
  - a changed listing page fails loudly.
- **Registry and parsing:** every accepted form per house, and every Brazilian form that parses today parses identically (a table test).
- **Suggester:** real titles from each official channel, plus titles that must give no suggestion (an interview on phoenix, a news clip).
- **Waiting:** the retry job's claim is compare-and-set (two runs send one job), and the window boundary is covered.
- **Worker tests run in the container,** one test run at a time (shared test DB).
- **yt-dlp on the Bundestag Mediathek and on House/Senate floor video is checked in the container only.** If it works, those links are accepted as video sources. If not, the upload says "Download the video yourself and upload the file." **[unverified]**

## 12. Delivery order

Each slice is shippable, and Brazil stays green after each.

1. **Registry and connector interface; Brazil moved.**
   - Registry, `RecordRef` variants, id systems.
   - `naming.ts` and `align.ts` made connector-driven.
   - House-aware copy, the new record field, Câmara by date.
   - Senado golden unchanged.
2. **Waiting state:** `waiting`, `retry_at`, the `records.retry` job, the copy.
3. **Bundestag connector:**
   - fixtures, listing lookup, XML parsing, titles;
   - the container check of Mediathek downloads;
   - the lag measurement.
4. **US connector:** CREC plus MODS, key handling, House and Senate, fixtures.
5. **YouTube suggestion:** the suggester, the `suggested` status, and the context-check and Who's who lines.
6. **Evaluation** on real videos (needs "spend approved"): Bundestag, US House, optionally Câmara. Then thresholds and the README.

## 13. Calls made in this design, for the owner to check

1. The Brazilian ids `camara` / `senado` stay; the new ids are `bundestag`, `us_house`, `us_senate`.
2. Person ids are per id system, so a US representative who becomes a senator is automatically one person (bioguide). A Brazilian deputy who becomes a senator stays two persons until Plan 5 decides how to merge (with your confirmation, as discussed).
3. A date means every sitting of that house that day. **This replaces the pick-from-a-list step I described.**
4. The YouTube suggester is rules only, with no AI call (free, predictable). It may miss videos with unusual titles; you can always type the date.
5. Names from a new house are proposals only until that house has a real-video evaluation.
6. The Bundestag gets no state or constituency, and the US gets no photos, until Plan 5.
7. "Not published yet" waits and retries every 6 h, for 21 days (Bundestag), 3 days (US) or 2 days (Brazil), and then fails.
8. Bundesrat out.
9. The UI stays English. The country is shown after the house for non-Brazilian houses.
10. US dates may be typed `MM/DD/YYYY` only when a US house is selected.
11. **Which videos get a suggestion:**
    - A parliament's own YouTube channel is enough.
    - A broadcaster (phoenix, C-SPAN) also needs a sitting word in the title.
    - Single speeches get suggestions too.
    - The suggestion shows only for the `parliament` profile.
12. **Accepting a suggestion at the context check** fetches the record right after you continue, before the analysis, so the first analysis already has the names.
13. The record field doesn't take a YouTube link. The suggestion comes from the session's own YouTube video.
14. The Who's who line shows the house for Brazilian speakers too ("PL-ES · Senado"). This is the only visible change for Brazil, apart from the record field.

## 14. Risks

- **Bundestag listing scraping:** the AJAX listing may change. Mitigations: the DIP key fallback, a loud failure, and a test on the recorded fragment.
- **US speech boundaries:** granules are organised by topic, and inserted remarks (text printed but never spoken) can appear inside the Record. Unspoken text only lowers similarity, and turns stay unnamed rather than wrong, but the evaluation will tell.
- **US presiding officer:** never named from the record in Plan 4. On House days the chair speaks often, so many short turns stay "Speaker X".
- **German and English text matching:** the TF-IDF matcher was tuned on Portuguese. German compounds and English boilerplate ("I yield back") may need per-language stop words. The evaluation sets the thresholds.
- **Video sources:** official House and Senate video may not download with yt-dlp. YouTube (C-SPAN and official channels) is the main path, and C-SPAN non-floor content is non-commercial only. Floor video is described as unrestricted **[unverified: C-SPAN's current terms]**.
- **Bundestag lag** is unmeasured. The waiting state covers it.

## 15. Left to the builder

- The registry's exact shape and file layout.
- Whether the US connector uses granule calls or the package zip.
- The Bundestag president-paragraph parsing details.
- `{time}` stamps as `at`.
- The help-text examples per house.
- Migration naming.
- The retry job's exact schedule within the stated cadence.
