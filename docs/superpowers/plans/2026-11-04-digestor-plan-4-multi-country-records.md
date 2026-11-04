# Plan 4: Parliaments of Several Countries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speaker names from the official record work for five houses in three countries:
- Brazil: Câmara and Senado, unchanged in behaviour;
- Germany: Bundestag;
- USA: House and Senate.

A video is linked to its sitting by house plus date, by an official link, or by a suggestion read from its YouTube details. A record that isn't published yet waits and is retried.

**Architecture:**
- **Registry:** a client-safe house registry in `packages/core` (`chambers.ts`) holds each house's labels, id system, language, publish window, titles, thresholds and suggestion patterns.
- **Connectors:** each house has one worker connector (`apps/worker/src/records/<house>.ts`) implementing `RecordConnector`.
- **Matching:** `naming.ts` and `align.ts` stop branching on `chamber`; they call the connector and read the registry.
- **New record states:**
  - `suggested`: a YouTube suggestion awaiting the journalist;
  - `waiting`: not published yet, retried by a scheduled `records.retry` job.
- **Graph:** the graph gains a second record step after the context check.

**Tech Stack:** TypeScript (strict, ESM), pnpm monorepo, Drizzle + Postgres, pg-boss 12, LangGraph JS 1.x, zod, Next.js 16 App Router, vitest. Dependencies:
- XML parsing for the Bundestag and MODS: `fast-xml-parser` (add to `apps/worker`).
- HTML entity decoding for CREC text: `he` or a small local map. **[builder]**

**Spec:** `docs/superpowers/specs/2026-11-04-digestor-plan-4-multi-country-records-design.md` (approved 2026-11-04). It builds on `docs/superpowers/specs/2026-11-02-digestor-plan-3-speaker-names-design.md` §7.4. Read both. The live research behind §5.4–5.5 is in `.superpowers/research/2026-11-04-parliament-sources.md` (git-ignored; read it for URLs and sample shapes).

## Global Constraints

- **Imports:**
  - `@digestor/core` stays client-safe; repo code is in `packages/core/src/db/*`, exported only from `@digestor/core/server`.
  - Relative imports in `packages/core` use `.ts`; the worker uses `.js`.
- **No ffmpeg or yt-dlp on the host.** Worker tests run in the container, one test run at a time (shared `digestor_test` DB): `docker compose run --rm worker pnpm --filter @digestor/worker test <pattern>`.
- **Concurrency is guarded in the database:**
  - Every `session_records` status change is compare-and-set, as in `packages/core/src/db/records.ts`.
  - `linkRecord` keeps its advisory lock.
  - `singletonKey` is never the guarantee.
- **Jobs:**
  - New queues use `JOB_OPTIONS` (create, update, send).
  - Deterministic errors record and return; transient errors rethrow (`pgboss-langgraph-gotchas` skill).
- **Fakes and fixtures:** recorded live and trimmed (`vendor-contract-check` skill). No paid API calls without the owner's "spend approved". The Bundestag, GovInfo, Câmara and Senado open data are free.
- **Brazil must not regress:** every existing test in `recordRef`, `camara`, `senado`, `align`, `naming`, `records` and `RecordLink` passes unchanged (only imports may move). Stored `session_records.ref` values and `persons.official_ids` keys stay valid without migration.
- **Exact ids:**
  - houses: `camara`, `senado`, `bundestag`, `us_house`, `us_senate`;
  - id systems: `camara`, `senado`, `bundestag`, `bioguide`;
  - countries: `BR`, `DE`, `US`.
- **Exact values:**
  - `publishWindowDays`: `camara` 2, `senado` 2, `bundestag` 21, `us_house` 3, `us_senate` 3;
  - retry cadence: every 6 h;
  - `records.retry` runs hourly;
  - starting thresholds 0.6 confirm / 0.35 propose. A house with `evaluated: false` uses confirm `Infinity`, so its names are proposals only. `camara` and `senado` are `evaluated: true`.
- **Env:** `API_DATA_GOV_KEY` (US; missing → `MissingApiKeyError("API_DATA_GOV_KEY")`, deterministic) and `BUNDESTAG_DIP_API_KEY` (optional fallback; missing is not an error). Both go in `.env.example` and `docs/deploy.md`.
- **Copy, exact** (UI strings in `apps/web/messages/en.ts`; worker lines as constants):
  - Câmara date with no plenary: "The Câmara has no plenary session on that date."
  - Waiting: "The {house} hasn't published the record of {date} yet. Digestor will check again. If there was no sitting that day, check the date."
  - Suggestion: "This looks like the {house} sitting of {date}." Buttons: "Use this record", "Not this one".
  - YouTube link in the record field: "Paste the date or the official record link."
  - An unsupported official video link in the record field: "Paste the date or sitting number instead."
  - Status lines use the house's `shortName` where today's say "Senado" or "Câmara".
- **Display:**
  - Who's who detail line: party, state where known, then the house's `shortName` for persons named from this session's record.
  - Non-Brazilian houses add " (Germany)" / " (USA)".
  - Examples: "SPD · Bundestag (Germany)", "D-NY · House (USA)", "PL-ES · Senado".
- **UI work:** read `.claude/skills/digestor-ui/SKILL.md` and `.claude/skills/nextjs16-gotchas/SKILL.md` first. Check at 1280 and 390 px with the `digestor-run` skill (errors.txt empty).

## Review Focus

1. **A link that contradicts the selected house.** A Câmara event link pasted while "Bundestag" is selected parses as the Câmara (the link wins). A plain date with no house parses as the Senado, as today. *Test in Task 1.*
2. **A Bundestag speech by a minister, a state secretary or the president** (no `<fraktion>`, a role instead) gets the right id or `null`, never the previous speaker's id. Interventions inside a `<rede>` by the president become their own speeches. *Test in Task 7.*
3. **Two members with the same surname in one granule:**
   - "Mr. SMITH of Texas" and "Mr. SMITH of New Jersey" each map to their own bioguide id.
   - A bare "Mr. SMITH" that matches two `parsed` names maps to `null`.
   *Test in Task 9.*
4. **Re-linking while a record is `waiting` or `suggested`.** The journalist types another date: the new ref goes to `pending`. The retry job and "Use this record" never resurrect the old ref (both compare the stored ref). *Tests in Tasks 6 and 11.*
5. **A record already linked at upload.** The YouTube suggester never overwrites a linked record or a dismissed suggestion. It only writes when the session has no `session_records` row. *Test in Task 10.*

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `packages/core/src/chambers.ts` (new) | house registry: labels, country, id system, language, window, titles, thresholds, `evaluated`, suggestion patterns | 1, 10 |
| `packages/core/src/recordRef.ts` | `RecordRef` union + `parseRecordRef(input, chamber?)` + `recordRefDate` | 1 |
| `packages/core/src/recordSuggest.ts` (new) | pure `suggestRecord(meta)` | 10 |
| `packages/core/drizzle/0012_*.sql`, `db/schema.ts` | `session_records.retry_at` and `linked_at`, status values, person id indexes | 2 |
| `packages/core/src/db/records.ts` | suggest / accept / dismiss / wait / claim-due functions | 2, 6, 11 |
| `packages/core/src/db/names.ts` | `upsertOfficialPerson` keyed by id system | 2 |
| `apps/worker/src/records/connector.ts` (new) | `RecordConnector`, `RecordSpeech`, `MemberInfo`, errors, `connectorFor` | 3 |
| `apps/worker/src/records/{senado,camara}.ts` | Brazilian connectors (moved behind the interface) | 3, 4 |
| `apps/worker/src/records/bundestag.ts`, `usCongress.ts` (new) | new connectors | 7, 9 |
| `apps/worker/src/records/align.ts` | matcher taking `speechText` + `stopWords` + thresholds | 3 |
| `apps/worker/src/records/retry.ts` (new) | `records.retry` cron job | 6 |
| `apps/worker/src/pipeline/naming.ts` | connector-driven `runClaimed`, waiting, generic lines | 3, 6 |
| `apps/worker/src/pipeline/graph.ts` | suggestion after download; `match_record_late` node | 10, 11 |
| `apps/web/components/Names/RecordLink.tsx`, `UploadForm.tsx`, `lib/recordInput.ts`, `lib/names.ts`, `app/api/sessions/[id]/record/route.ts`, upload and youtube routes, `ContextCheck.tsx`, `WhosWho.tsx` | field, routes, lines, suggestion UI | 5, 6, 11 |

---

### Task 1: House registry and record refs (core, pure)

**Files:**
- Create: `packages/core/src/chambers.ts`, `packages/core/src/chambers.test.ts`
- Modify: `packages/core/src/recordRef.ts`, `packages/core/src/recordRef.test.ts`, `packages/core/src/index.ts` (exports)

**Interfaces:**
- Produces:
  ```ts
  type ChamberId = "camara" | "senado" | "bundestag" | "us_house" | "us_senate";
  type IdSystem = "camara" | "senado" | "bundestag" | "bioguide";
  type Chamber = {
    id: ChamberId; country: "BR" | "DE" | "US"; countryName: "Brazil" | "Germany" | "USA";
    name: string; shortName: string; idSystem: IdSystem; defaultLanguage: "pt" | "de" | "en";
    publishWindowDays: number; titles: string[]; evaluated: boolean;
    thresholds: { confirm: number; propose: number };
  };
  const CHAMBERS: Record<ChamberId, Chamber>;
  const CHAMBER_IDS: ChamberId[];             // display order: camara, senado, bundestag, us_house, us_senate
  function chamberThresholds(id: ChamberId): { confirm: number; propose: number }; // confirm = Infinity when !evaluated
  function chamberLabel(id: ChamberId): string; // "Senado", "Bundestag (Germany)", "House (USA)"
  type RecordRef =
    | { chamber: "senado"; date: string; sessionCode: string | null; url: string }        // unchanged
    | { chamber: "camara"; eventId: string; url: string }                                  // unchanged
    | { chamber: "camara"; date: string; url: string }                                     // new: sitting day
    | { chamber: "bundestag"; period: number; sitting: number | null; date: string | null; url: string }
    | { chamber: "us_house" | "us_senate"; date: string; url: string };
  function parseRecordRef(input: string, chamber?: ChamberId): RecordRef | null;
  function recordRefDate(ref: RecordRef): string | null; // DD/MM/YYYY for any ref with a date; null otherwise
  function recordInputError(input: string, chamber?: ChamberId): string | null; // a friendly line for a YouTube link or an unsupported official video link, else null
  ```
- Values:
  - names: "Câmara dos Deputados", "Senado Federal", "Deutscher Bundestag", "U.S. House of Representatives", "U.S. Senate";
  - `shortName`s: "Câmara", "Senado", "Bundestag", "House", "Senate";
  - titles:
    - Bundestag: "Abg.", "Präsident", "Präsidentin", "Vizepräsident", "Vizepräsidentin", "Bundesminister", "Bundesministerin", "Bundeskanzler", "Bundeskanzlerin", "Staatssekretär", "Staatssekretärin", "Dr.";
    - US: "Mr.", "Mrs.", "Ms.", "Miss", "Rep.", "Representative", "Sen.", "Senator", "Speaker";
    - the Brazilian lists move here from `stripTitle` in `naming.ts`.
- The URL of a new ref (`ref.url`, evidence and the "open record" link):
  - Câmara day: `https://www.camara.leg.br/agenda?dataInicial=DD/MM/YYYY&dataFinal=DD/MM/YYYY` **[builder: verify the shape, else the API events URL]**;
  - Bundestag: `https://www.bundestag.de/services/opendata` until the connector resolves the XML URL;
  - US: `https://www.congress.gov/congressional-record/YYYY/MM/DD/house-section` (or `senate-section`) **[builder: verify]**.

- [ ] **Step 1: Write the failing tests.**
  - **`recordRef.test.ts` "Brazilian parity" table:** every input the existing tests accept gives a deep-equal ref with `chamber` undefined, `"senado"` and `"camara"`, and the same `null`s. The old behaviour is kept with no chamber passed. Plus:
    - `parseRecordRef("16/10/2026", "bundestag")` → `{ chamber: "bundestag", period: 21, sitting: null, date: "2026-10-16", … }` (period from the date: 21 starts 2025-03-25 **[builder: keep a small period table 19/20/21]**);
    - `parseRecordRef("21/103", "bundestag")` → `{ chamber: "bundestag", period: 21, sitting: 103, date: null, … }`;
    - `parseRecordRef("2026-11-03", "camara")` → `{ chamber: "camara", date: "2026-11-03", … }`;
    - `parseRecordRef("11/03/2026", "us_house")` → date `"2026-11-03"` (MM/DD/YYYY);
    - `parseRecordRef("11/03/2026", "senado")` → date `"2026-03-11"` (DD/MM/YYYY);
    - `parseRecordRef("https://www.camara.leg.br/evento-legislativo/82635", "bundestag")` → the Câmara event ref (Review Focus 1);
    - `parseRecordRef("2026-11-03")` → Senado, as today (Review Focus 1);
    - `parseRecordRef("21/103", "us_house")` → `null`;
    - `recordInputError("https://www.youtube.com/watch?v=x")` → "Paste the date or the official record link.";
    - `recordInputError("https://www.bundestag.de/mediathek/video?videoid=7612345")` → "Paste the date or sitting number instead." (unless Task 8 makes it a record link).
  - **`chambers.test.ts`:**
    - `chamberThresholds("bundestag").confirm === Infinity`;
    - `chamberThresholds("senado")` equals `{ confirm: 0.6, propose: 0.35 }`;
    - `chamberLabel("us_house") === "House (USA)"`, `chamberLabel("senado") === "Senado"`.
- [ ] **Step 2: Run them; they fail.** `pnpm --filter @digestor/core test recordRef chambers`
- [ ] **Step 3: Implement** `chambers.ts` and the `recordRef.ts` changes. Keep the existing `senadoDayUrl` and `parseDate` and add `MM/DD/YYYY` only on the US path. A link still decides its own house.
- [ ] **Step 4: Run the tests, then `pnpm typecheck`.** The typecheck will flag every `ref.chamber === "camara"` that assumed `eventId`; fix those by narrowing on `"eventId" in ref`. No behaviour change.
- [ ] **Step 5: Commit** `feat(core): house registry and record refs for five houses`.

### Task 2: Schema and person ids by id system

**Files:**
- Create: `packages/core/drizzle/0012_multi_country_records.sql` (via the repo's drizzle workflow, like 0011)
- Modify: `packages/core/src/db/schema.ts`, `packages/core/src/db/names.ts`, `packages/core/src/db/records.ts`, their tests, `apps/worker/src/pipeline/naming.ts` (call site only)

**Interfaces:**
- Produces:
  - `RecordStatus = "suggested" | "pending" | "running" | "matched" | "failed" | "waiting"`;
  - `session_records.retry_at timestamptz null`;
  - `session_records.linked_at timestamptz not null default now()`, backfilled from `updated_at` and set by `linkRecord` whenever the ref changes (kept when the same ref is linked again);
  - `SessionRecord.linkedAt: Date`;
  - `SessionRecord.chamber: ChamberId` and `retryAt: Date | null`;
  - unique indexes `persons_official_bundestag` and `persons_official_bioguide`;
  - `upsertOfficialPerson(db, p: { idSystem: IdSystem; officialId; displayName; fullName?; party?; state?; role?; photoUrl? })`: the `chamber` parameter is renamed `idSystem`, the advisory-lock key becomes `person:<idSystem>:<id>`, and the JSON key is `idSystem`.

- [ ] **Step 1: Failing tests:**
  - **`names.test.ts`:**
    - `upsertOfficialPerson` with `idSystem: "bioguide", officialId: "N000002"` twice returns one person;
    - a `camara` and a `senado` upsert of the same digits stay two persons;
    - existing tests pass after renaming the argument.
  - **`records.test.ts`:** a row with `status: "waiting"` and a `retryAt` round-trips; `claimRecordFetch` does not claim `waiting` or `suggested` rows; `linkRecord` with a new ref sets `linkedAt`, and with the same ref keeps it.
- [ ] **Step 2: Run; they fail.** `pnpm --filter @digestor/core test names records`
- [ ] **Step 3: Implement.**
  - The migration adds the column and the two indexes; status is plain text, so no constraint changes.
  - Update `upsertOfficialPerson` and its one worker call site (`idSystem: CHAMBERS[ref.chamber].idSystem`).
- [ ] **Step 4: Run the tests and apply the migration.**
  - `pnpm --filter @digestor/core test`
  - `pnpm db:migrate` (with postgres healthy)
  - `pnpm typecheck`
- [ ] **Step 5: Commit** `feat(core): record statuses suggested/waiting, person ids by id system (0012)`.

### Task 3: Connector interface; Brazil moved behind it

**Files:**
- Create: `apps/worker/src/records/connector.ts`, `apps/worker/scripts/rematch-record.ts`
- Modify: `apps/worker/src/records/{senado,camara,align,fakeSenado,fakeCamara}.ts` and tests; `apps/worker/src/pipeline/naming.ts` and `naming.test.ts`; `packages/core/src/db/names.ts` (`Attribution` evidence type); `apps/web/lib/names.ts` (`evidenceLine`, only reading the new optional fields)

**Interfaces:**
- Produces (`connector.ts`):
  ```ts
  interface RecordSpeech { id: string; order: number; officialId: string | null; name: string; party: string | null;
    state: string | null; text: string; at?: string; textSource: "full" | "summary" }
  type MemberInfo = { displayName: string; fullName?: string | null; party?: string | null; state?: string | null; photoUrl?: string | null };
  interface RecordConnector {
    chamber: ChamberId;
    fetchRecord(ref: RecordRef, f: typeof fetch, ctx: { now: Date; linkedAt: Date }): Promise<{ speeches: RecordSpeech[]; date: string; url?: string; members: Record<string, MemberInfo> }>;
    speechText(speech: RecordSpeech): string;
    stopWords: ReadonlySet<string>;
  }
  class RecordNotFoundError extends Error {}      // moved from senado.ts, same default message
  class RecordNotPublishedError extends Error {}  // used from Task 6
  function connectorFor(chamber: ChamberId): RecordConnector;
  ```
  - `fetchRecord` returns `url` when the connector resolved a better record URL than the ref's (Bundestag XML), and evidence uses it.
  - Record evidence gains optional `chamber: ChamberId` and `date: string` (YYYY-MM-DD).
  - `recordAttributions(turns, speeches, matches, personIdOf, ref, thresholds)` skips speeches with `officialId === null`.
  - `similarityMatrix(turns, speeches, connector)` uses `connector.speechText` and `connector.stopWords`.
  - The line helpers in `naming.ts` take the registry: `recordNoMatch(ref, date)`, `recordFetchFailed(ref?)`.
- Consumes: Task 1's `CHAMBERS` and `chamberThresholds`; Task 2's `upsertOfficialPerson({ idSystem })`.

- [ ] **Step 1: Failing tests:**
  - **`align.test.ts`:**
    - a speech with `officialId: null` takes part in the alignment (it absorbs the turn it matches), but yields no attribution;
    - with `chamberThresholds("bundestag")`, a 0.95 match is `proposed`.
  - **`naming.test.ts`:**
    - existing Senado and Câmara cases give byte-identical attributions and lines through `connectorFor`;
    - a fake connector registered for `bundestag` (test-only injection, e.g. `RecordStepDeps.connectors?`) drives `runRecordStep` end to end, upserting persons with `idSystem: "bundestag"` and writing evidence with `chamber: "bundestag"` and `date`.
  - **Web `lib/names.test.ts`:**
    - evidence with `chamber: "bundestag", date: "2026-10-16"` renders "From the Bundestag record of 16/10/2026: speech 12, 0.81 match";
    - old Senado and Câmara evidence (no `chamber`) renders exactly as today.
- [ ] **Step 2: Run; they fail** (worker in the container: `… test align naming`; web: `pnpm --filter @digestor/web test names`).
- [ ] **Step 3: Implement.**
  - Senado connector: `fetchRecord` = `fetchSenadoSpeeches` plus the `fetchSenador` loop moved out of `naming.ts`, filling `members`.
  - Câmara connector: the deputies list becomes `members`.
  - Both connectors' `speechText` and `stopWords` are today's `speechText` and `STOP`, unchanged.
  - `naming.ts` `runClaimed` keeps its exact sequence (claim → fetch → tieOrder → align → upsert → stale check → replace → finish). It only swaps the two branches for `connectorFor(ref.chamber)` and `members`.
  - Add the copy key `names.evidenceRecordHouse: "From the {house} record of {date}: speech {speech}, {score} match"`.
- [ ] **Step 4: Add `scripts/rematch-record.ts <sessionId>`.** It re-links the session's stored ref (`linkRecord` with the same ref keeps human rows) and calls `runRecordStep`. Then the regression check on the Senado session (the one `apps/worker/eval/senado-2026-06-30.golden.json` names; find its full id with `select id from sessions where id::text like 'f2fce3ea%'`):
  ```bash
  docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/rematch-record.ts <id>
  docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/eval.ts <id> eval/senado-2026-06-30.golden.json
  ```
  Expected: the same table as the README Evaluation section: wrong-name rate 0%, score 0.93. The Senado API is free. Paste both outputs into the report.
- [ ] **Step 5: Run the full worker suite and `pnpm test`; commit** `refactor(worker): record connectors; Senado and Câmara behind one interface`.

### Task 4: Câmara by date

**Files:**
- Modify: `apps/worker/src/records/camara.ts`, `camara.test.ts`, `fakeCamara.ts`
- Create: `apps/worker/test/fixtures/camara-eventos-2026-06-30.json` (recorded live, trimmed)

**Interfaces:**
- Consumes: the Câmara day ref `{ chamber: "camara"; date }` (Task 1) and `RecordConnector` (Task 3).

- [ ] **Step 1: Record the fixture.**
  - Request: `GET https://dadosabertos.camara.leg.br/api/v2/eventos?dataInicio=2026-06-30&dataFim=2026-06-30&itens=100` (`Accept: application/json`, free).
  - Find the filter that keeps plenary events. `codTipoEvento` or `idOrgao` for PLEN **[unverified]**; otherwise filter the list by `orgaos[].sigla === "PLEN"` in code.
  - Note the request and the date in the fixture's sibling `.md` or a header comment in the fake.
- [ ] **Step 2: Failing tests in `camara.test.ts`:**
  - a day with one ended plenary returns the same speeches as the event-id path for event 82635;
  - a day with two ended plenaries returns both events' speeches, ordered by stamp, with deputies merged;
  - a day where the only plenary isn't `Encerrada` throws `RecordNotFoundError(CAMARA_NOT_COMPLETE)`;
  - a day with no plenary throws `RecordNotFoundError("The Câmara has no plenary session on that date.")`.
- [ ] **Step 3: Run; they fail.**
- [ ] **Step 4: Implement** `fetchCamaraDay(date, f)`. It reuses the per-event fetch, so the window, PLEN and situacao rules are not duplicated. `fetchRecord` dispatches on `"eventId" in ref`.
- [ ] **Step 5: Run `camara` and `naming`; commit** `feat(worker): Câmara record by date`.

### Task 5: Record field, routes and house-aware lines (web)

**Files:**
- Modify: `apps/web/components/Names/RecordLink.tsx` (+ test), `apps/web/components/UploadForm.tsx`, `apps/web/lib/recordInput.ts`, `apps/web/app/api/sessions/[id]/record/route.ts`, the upload and youtube routes under `apps/web/app/api/sessions/`, `apps/web/lib/names.ts`, `apps/web/components/Names/WhosWho.tsx`, `apps/web/messages/en.ts`, and the related route tests

**Interfaces:**
- Consumes: `parseRecordRef(input, chamber?)`, `recordInputError`, `CHAMBERS`, `CHAMBER_IDS`, `chamberLabel` (Task 1).
- Produces:
  - API bodies and query strings take an optional `chamber` (one of the five ids, or absent = "Detect from the link") next to `ref` / `record`. An unknown `chamber` → 400 with `record.invalid`.
  - `GET /api/sessions/[id]/record` returns `chamber` as any `ChamberId`, plus `retryAt` (ISO or null) and, for `suggested` rows, the suggested date.
  - `readRecordInput(raw, chamber?)`.

- [ ] **Step 1: Failing tests:**
  - **Route tests:**
    - `{ ref: "21/103", chamber: "bundestag" }` stores a Bundestag ref;
    - `{ ref: "2026-10-21" }` (no chamber) stores the Senado ref exactly as today;
    - a YouTube link answers 400 "Paste the date or the official record link.";
    - `chamber: "xx"` → 400.
  - **`RecordLink.test.ts`:** the select lists "Detect from the link" then the five houses grouped by country with `chamberLabel`s; the help text changes with the house (one example per accepted form).
  - **`lib/names.test.ts`:**
    - `recordMatchedLine` for `bundestag` with a date → "Names from the Bundestag record of 16/10/2026";
    - Senado and Câmara strings unchanged.
  - **Who's who detail line:**
    - a person with party "SPD" named from a `bundestag` record → "SPD · Bundestag (Germany)";
    - party "PL", state "ES", from a `senado` record → "PL-ES · Senado";
    - a person not named from a record keeps today's line.
- [ ] **Step 2: Run; they fail.** `pnpm --filter @digestor/web test`
- [ ] **Step 3: Implement.**
  - The select's last choice is kept in `localStorage` under `digestor.recordChamber`, with every access in try/catch.
  - The select switches to "Detect from the link" whenever the text box holds a URL.
  - Copy goes in `en.ts`; replace `record.invalid` with a house-neutral line: "Pick the house and paste the date, the sitting number or the official record link."
- [ ] **Step 4: Verify in the browser** with the `digestor-run` skill: upload form and Who's who at 1280 and 390 px, `errors.txt` empty. Read the screenshots.
- [ ] **Step 5: Run `pnpm test` and `pnpm typecheck`; commit** `feat(web): house select for the official record; house-aware lines`.

### Task 6: Waiting for a record that isn't published

**Files:**
- Create: `apps/worker/src/records/retry.ts` (+ test)
- Modify: `packages/core/src/db/records.ts` (+ test), `apps/worker/src/pipeline/naming.ts` (+ test), `apps/worker/src/records/{senado,camara}.ts`, `apps/worker/src/main.ts`, `apps/web/messages/en.ts`, `apps/web/components/Names/RecordLink.tsx`, `apps/web/lib/names.ts`, `CLAUDE.md` (queues line)

**Interfaces:**
- Produces:
  - `waitRecordFetch(db, sessionId, ref, retryAt: Date): Promise<boolean>`: `running` → `waiting` for this ref.
  - `claimDueRecordRetries(db, now: Date): Promise<string[]>`: compare-and-set `waiting` → `pending` where `retry_at <= now`, returning the session ids.
  - `notPublishedOrNotFound(chamber, date: string | null, now: Date, notFoundMessage: string, linkedAt?: Date): RecordNotPublishedError | RecordNotFoundError`, in `connector.ts`. When `date` is null, the window counts from `linkedAt`.
  - `RECORDS_RETRY_QUEUE = "records.retry"` and `RECORDS_RETRY_CRON = "0 * * * *"` in `retry.ts`.
  - `RECORD_RETRY_HOURS = 6`.
- Behaviour:
  - In `runClaimed`, a `RecordNotPublishedError` → `waitRecordFetch(…, now + 6 h)`, and the row's `error` holds the waiting line.
  - The Senado connector: an empty day goes through `notPublishedOrNotFound`.
  - The Câmara connector: a day with no ended plenary, and an event that isn't `Encerrada`, go through `notPublishedOrNotFound`. Within 2 days → waiting, else today's lines.
  - The cron handler claims due rows, then for each sends `session.names` (`JOB_OPTIONS`). A failed send puts the row back to `waiting` with `retry_at = now + 1 h`.
  - The sweep's R32 query stays as is. `waiting` and `suggested` are not in it; add a comment saying so.

- [ ] **Step 1: Failing tests:**
  - **`records.test.ts`:**
    - two concurrent `claimDueRecordRetries` return the session once;
    - a row re-linked (`linkRecord` with another ref) while `waiting` is `pending` with the new ref, and `retry_at` is null (Review Focus 4).
  - **`connector` unit:** for `senado`, a date 1 day ago → not published; 3 days ago → not found. For `bundestag`, 20 days → not published; 22 → not found.
  - **`naming.test.ts`:**
    - a connector throwing `RecordNotPublishedError` leaves the row `waiting` with `retryAt` ≈ now + 6 h and the waiting line;
    - attributions are untouched.
  - **`retry.test.ts`:** a due row is claimed and one `session.names` job is sent; a row not yet due is left alone.
  - **Sweep:** a `waiting` row older than 30 min is not failed.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
  - Schedule `records.retry` in `main.ts` next to `SWEEP_QUEUE`, created and updated with `JOB_OPTIONS`.
  - Web: the `waiting` line comes from `record.error` or a copy key. Who's who polls as for `pending`.
- [ ] **Step 4: Run the worker suite and `pnpm test`; commit** `feat: wait and retry when the official record isn't published yet`.

### Task 7: Bundestag connector

**Files:**
- Create: `apps/worker/src/records/bundestag.ts`, `bundestag.test.ts`, `fakeBundestag.ts`, plus these fixtures (recorded live, trimmed to about 6 `<rede>` elements including a president intervention, a minister and a `<kommentar>`):
  - `apps/worker/test/fixtures/bundestag-filterlist-wp21.html`
  - `apps/worker/test/fixtures/bundestag-21103.xml`
- Modify: `apps/worker/package.json` (`fast-xml-parser`), `connector.ts` (register), `packages/core/src/chambers.ts` (German stop-word list lives in the worker connector, not core)

**Interfaces:**
- Consumes: `RecordConnector`, `notPublishedOrNotFound` (Tasks 3 and 6); the `bundestag` ref (Task 1).
- Produces: `bundestagConnector` with:
  - `findSitting(ref, f): Promise<{ xmlUrl: string; period: number; sitting: number; date: string } | null>`
  - `parseProtokoll(xml: string): { date: string; speeches: RecordSpeech[]; members: Record<string, MemberInfo> }`

- [ ] **Step 1: Record the fixtures.**
  - Requests: `GET https://www.bundestag.de/ajax/filterlist/de/services/opendata/1058442-1058442?limit=10&noFilterSet=true`, then the XML it links for sitting 103.
  - Note each URL and the date in a header comment of `fakeBundestag.ts`.
  - Inspect the president's markup in the full file before trimming (spec §5.4 marks it unverified). Write down what you found in the report.
- [ ] **Step 2: Failing tests:**
  - **`parseProtokoll`:**
    - speeches come in document order;
    - `officialId` comes from `<redner id>`;
    - `<kommentar>` text is absent from `speechText`;
    - the president's intervention inside a `<rede>` is its own speech, with the president's id when the markup carries one, else `null`;
    - a minister's speech has the minister's id and no party (Review Focus 2);
    - the root's `sitzung-datum` "16.10.2026" → `date` "2026-10-16".
  - **`findSitting`:**
    - by sitting number 103 → the blob URL;
    - by date `2026-10-16` → the same;
    - the root attributes must agree with the ref, otherwise `RecordNotFoundError`;
    - a filterlist with no parseable links → a plain (transient) `Error` whose message names the listing URL (the anti-goal of no silent scraping failure);
    - sitting 104, newer than the last listed (103) → `RecordNotPublishedError` counted from `linkedAt`; sitting 50 missing from the listing → `RecordNotFoundError`.
  - **DIP fallback:** with `BUNDESTAG_DIP_API_KEY` set and the listing failing, `findSitting` calls `https://search.dip.bundestag.de/api/v1/plenarprotokoll?f.dokumentnummer=21/103&apikey=…` (fake response modelled on the DIP docs; no live call is possible without a key). Without the key, the listing error propagates.
  - **Matching:** the German `stopWords` include at least "und der die das den dem des ein eine einer nicht mit auf für ist sich auch wir sie ich es zu von im in herr frau präsident präsidentin kollegen kolleginnen damen herren".
- [ ] **Step 3: Run; they fail. Implement**, with requests 4 at a time through `records/http.ts`.
- [ ] **Step 4: Measure the lag.**
  - Note the most recent sitting date and when its XML first appears in the listing. Check once a day during the build; record what's known by the end of the plan.
  - Put the finding in the spec's §5.4 as a dated note.
- [ ] **Step 5: Run `bundestag` and `naming`; commit** `feat(worker): Bundestag record connector`.

### Task 8: Official video links (container check)

**Files:**
- Modify (only if the check passes): the youtube route's URL validation in `apps/web/app/api/sessions/youtube/`, `packages/core/src/recordRef.ts` (`recordInputError` for Mediathek), `docs/deploy.md`

- [ ] **Step 1: Check, inside the worker container only**, whether yt-dlp fetches each of:
  - a Bundestag Mediathek video (`https://www.bundestag.de/mediathek/video?videoid=…` of a recent plenary speech);
  - a House floor video from `live.house.gov` or `clerk.house.gov`;
  - a Senate floor video from `senate.gov`.

  Use `--simulate --print title` (no download). Also check whether the Mediathek page states its sitting (number or date) in a stable place.
- [ ] **Step 2: Record** each result (works or not, with the command and the error) in the report and in `docs/deploy.md`.
- [ ] **Step 3: Accept passing hosts** in the YouTube/link route as video sources. `sessions.source` stays `"youtube"` for any yt-dlp link **[my call]**. The suggester (Task 10) uses their metadata the same way. Add a route test per accepted host. If the Mediathek page has a stable sitting reference, make it a record link in `parseRecordRef` with a test. Otherwise keep the "Paste the date or sitting number instead." line.
- [ ] **Step 4: If nothing passes**, change no code: the deploy note is the deliverable.
- [ ] **Step 5: Commit** `feat: accept official parliament video links` (or `docs: official video links checked`).

### Task 9: US House and Senate connector

**Files:**
- Create: `apps/worker/src/records/usCongress.ts`, `usCongress.test.ts`, `fakeUsCongress.ts`, plus these fixtures (recorded live with the owner's `API_DATA_GOV_KEY`):
  - `apps/worker/test/fixtures/crec-<date>-granules.json`
  - one House granule's `.htm` and `.mods.xml`
  - one Senate granule's `.htm` and `.mods.xml`
- Modify: `connector.ts` (register `us_house` and `us_senate`), `.env.example`, `docs/deploy.md`, `CLAUDE.md` (env line)

**Interfaces:**
- Consumes: `RecordConnector`, `notPublishedOrNotFound`, the US refs.
- Produces:
  - `usHouseConnector` and `usSenateConnector` (one implementation parameterised by `granuleClass` "HOUSE" | "SENATE");
  - `parseGranule(htm: string, mods: string): RecordSpeech[]`.

- [ ] **Step 1: Ask the controller for `API_DATA_GOV_KEY`** if `.env` lacks it (the owner provides it; never commit it). Record the fixtures:
  - a recent House day with a same-surname pair if one can be found;
  - one Senate day.

  Note the URLs and dates in `fakeUsCongress.ts`.
- [ ] **Step 2: Failing tests:**
  - **`parseGranule`:**
    - labels at line start split speeches;
    - `Mr. NADLER.` → `N000002` with party "D" and state "NY" from MODS;
    - `The SPEAKER pro tempore.`, `The PRESIDING OFFICER.` and `The CLERK.` → `officialId: null`;
    - `[[Page H2791]]` and `{time} 1315` lines are absent from the text;
    - "Mr. SMITH of Texas" and "Mr. SMITH of New Jersey" each map to their own id; a bare "Mr. SMITH" matching two `parsed` names → `null`; a label with no `parsed` match → `null` (Review Focus 3).
  - **`fetchRecord`:**
    - only granules of the connector's class are used, ordered by page;
    - EXTENSIONS and DAILYDIGEST are never used;
    - a 404 on the package within 3 days → not published, older → "The House has no record for that date." / "The Senate has no record for that date.";
    - a missing key → `MissingApiKeyError("API_DATA_GOV_KEY")`, deterministic: the row fails with that line and there is no retry.
  - **Matching:** the English `stopWords` include at least "the and that this with have for are was were not you your our from they their there which would will been has had speaker madam president gentleman gentlewoman yield time chair".
- [ ] **Step 3: Run; they fail. Implement**, with requests 4 at a time. Use the package-level MODS or zip if it cuts requests **[builder]**; say which in the report.
- [ ] **Step 4: Run `usCongress` and `naming`; commit** `feat(worker): US House and Senate record connector`.

### Task 10: Suggestion from the YouTube details

**Files:**
- Create: `packages/core/src/recordSuggest.ts`, `recordSuggest.test.ts`
- Modify: `packages/core/src/chambers.ts` (suggestion patterns), `packages/core/src/db/records.ts` (+ test), `apps/worker/src/pipeline/graph.ts` (+ `graph.test.ts`)

**Interfaces:**
- Produces:
  - `suggestRecord(meta: { title: string; description: string; channel: string; uploadDate: string | null }): RecordRef | null`. Pure; rules from spec §6.3.
  - Per house in the registry: `ownChannels: RegExp[]`, `broadcasterChannels: RegExp[]`, `sittingWords: RegExp[]`.
  - `suggestRecordRow(db, sessionId, ref): Promise<boolean>`: inserts `status: "suggested"` only when the session has **no** `session_records` row. Returns false otherwise.
- Behaviour:
  - In the graph, after a successful `download`, if `suggestRecord(metadata)` returns a ref, call `suggestRecordRow`. An error is logged and never fails the session.
  - The metadata is what `downloadYouTube` already returns. Store it on `sessions.metadata` if it isn't kept already **[builder: check]**.

- [ ] **Step 1: Collect real titles.** Collect 5–10 real titles (with channel, description start and upload date) per house from their official and broadcaster YouTube channels. Use the public pages, or `yt-dlp --simulate` **in the container**. Put them in `recordSuggest.test.ts` as fixtures.
- [ ] **Step 2: Failing tests:**
  - each real floor title gives the expected house and date or sitting;
  - single-speech titles from own channels give a suggestion;
  - a phoenix interview, a C-SPAN hearing and a news clip give `null`;
  - a broadcaster video with only `uploadDate` → `null`;
  - an own-channel video with only `uploadDate` → that date.
  - `graph.test.ts`:
    - a YouTube session with a Bundestag title gets a `suggested` row;
    - a session linked at upload keeps its row untouched (Review Focus 5);
    - an upload (file) session gets none.
- [ ] **Step 3: Run; they fail. Implement.**
- [ ] **Step 4: Run the core tests and the worker `graph` tests; commit** `feat: suggest the sitting from the YouTube details`.

### Task 11: Accepting a suggestion; the second record step

**Files:**
- Modify:
  - `packages/core/src/db/records.ts` (+ test)
  - `apps/web/app/api/sessions/[id]/record/route.ts` (+ test)
  - `apps/web/components/ContextCheck.tsx`, `apps/web/components/Names/WhosWho.tsx`, `RecordLink.tsx`, `apps/web/messages/en.ts`
  - `apps/worker/src/pipeline/graph.ts` (+ test)
  - `CLAUDE.md` (graph line)

**Interfaces:**
- Produces:
  - `acceptSuggestedRecord(db, sessionId, ref): Promise<boolean>`: `suggested` → `pending` only when the stored ref equals `ref`.
  - `dismissSuggestedRecord(db, sessionId, ref): Promise<boolean>`: deletes the row only when it is `suggested` with that ref.
  - `POST /api/sessions/[id]/record` with `{ action: "accept" | "dismiss" }`:
    - accept → 202, and sends `session.names` only when the transcript exists **and** the session is not at `awaiting_context`;
    - dismiss → 200;
    - a stale ref → 409 "That suggestion changed. Reload the page.".
  - The graph node `match_record_late` (same function as `matchRecordNode`) sits between the context step and `name_speakers`. Every edge that went to `name_speakers` now goes to `match_record_late`, then on to `name_speakers`.
- Display:
  - The suggestion shows only while `profile === "parliament"` (read from the session or card). A hidden one comes back if the profile changes back.

- [ ] **Step 1: Failing tests:**
  - **`records.test.ts`:**
    - accept with the stored ref → `pending`;
    - accept after a re-link to another ref → false, and the row is untouched (Review Focus 4);
    - dismiss deletes only a `suggested` row.
  - **Route test:** accept while the session is `awaiting_context` sends no job; accept on a `ready` session sends one.
  - **`graph.test.ts`:**
    - a session paused at the context check whose suggestion is accepted, then resumed with Continue, runs `match_record_late`, and the record's names exist before `analyze`;
    - with no pending record, `match_record_late` is a no-op;
    - an old checkpoint whose `next` is `name_speakers` still resumes.
  - **Component tests:**
    - the suggestion line "This looks like the Bundestag sitting of 16/10/2026." with "Use this record" / "Not this one" renders in the context check and in Who's who for `parliament`, and not for `interview`;
    - "Not this one" opens the record field.
- [ ] **Step 2: Run; they fail. Implement.**
- [ ] **Step 3: Verify in the browser** with `digestor-run`. Seed a session at `awaiting_context` with a `suggested` row (extend `scripts/seed-demo.ts` with `--suggest bundestag`), view it at 1280 and 390 px, click both buttons, and check `errors.txt` is empty.
- [ ] **Step 4: Run all suites; commit** `feat: confirm a suggested record at the context check`.

### Task 12: Evaluation on real videos (owner's spend needed)

**Files:**
- Create:
  - `apps/worker/eval/bundestag-<date>.golden.json`
  - `apps/worker/eval/us-house-<date>.golden.json`
- Modify:
  - `packages/core/src/chambers.ts`: `evaluated: true` and tuned thresholds per evaluated house;
  - `README.md` (Evaluation, Roadmap);
  - `scripts/smoke.md`

This task is run by the controller with the owner, not by an implementer subagent.

- [ ] **Step 1: Ask the owner for "spend approved"** (about $1–2 in total) and for the videos, or propose them:
  - a Bundestag floor debate of about 30–60 min from the official channel;
  - a US House floor segment of similar length.

  Optionally add the Câmara plenary (event 82635) if the owner has the link.
- [ ] **Step 2: Run each video end to end, linking its record.** Use the suggestion when it appears; this also tests Task 10–11 for real.
- [ ] **Step 3: Write the goldens** (30 turns each, as in Task 16 of Plan 3). The owner accepts them.
- [ ] **Step 4: Run the eval script and tune thresholds** so wrong names stay under 1% of speaking time (Plan 3's target). Set `evaluated: true` only for houses that meet it.
- [ ] **Step 5: Update the README Evaluation table and Roadmap** (Plan 4 done; Plan 5 the Tracker). Commit `feat: evaluate Bundestag and US House naming; thresholds`.

---

## Self-review notes

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §5.1 | 1 |
| §5.2 | 3 |
| §5.3 | 3, 4 |
| §5.4 | 7 (lag: Task 7 Step 4) |
| §5.5 | 9 |
| §6.1 | 1, 5, 8 |
| §6.2 | 4, plus the matcher's existing skip |
| §6.3 | 10, 11 |
| §7 | 6 |
| §8 | 2 |
| §9 | 3, 5, 6, 11 |
| §10 | 3 Step 4, 12 |
| §11 | each task |
| §12 order | Tasks 1–5 = slice 1; 6 = 2; 7–8 = 3; 9 = 4; 10–11 = 5; 12 = 6 |

**Owner inputs needed:**
- `API_DATA_GOV_KEY` before Task 9;
- optionally `BUNDESTAG_DIP_API_KEY`;
- "spend approved" and videos for Task 12.
