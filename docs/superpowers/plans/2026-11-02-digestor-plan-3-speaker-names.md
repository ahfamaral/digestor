# Plan 3: Real Speaker Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voices get real names with sources (record, caption, transcript, video details, the human). Every screen shows them, focus and "Find more" work per person, and export is blocked until each speaker in a clip is confirmed or marked "no name".

**Architecture:**
- **Names live in one place.** A session-level `attributions` table (with history) links diarized voices, over an optional time range, to `persons`. A pure, client-safe resolver (`personAt`) decides what every screen shows.
- **Proposals come from sources.** The context agent's names, captions read by a vision model, and the Senado record matched to transcript turns each write AI rows. Humans confirm or fix them through one API.
- **Names never re-run moment work.** Names change the display, the focus filter and the export checklist only.

**Tech Stack:** TypeScript (strict, ESM), pnpm monorepo, Drizzle + Postgres, pg-boss 12, LangGraph JS 1.x, LangChain (`@langchain/anthropic`, OpenRouter adapter), zod, Next.js 16 App Router, vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-digestor-plan-3-speaker-names-design.md` (approved 2026-11-02). It builds on `docs/superpowers/specs/2026-10-30-digestor-ui-concept-design.md`. Read both.

## Global Constraints

- **Imports and packages:**
  - `@digestor/core` stays client-safe: DB and repo code goes in `packages/core/src/db/*` and is exported only from `@digestor/core/server`.
  - Relative imports inside `packages/core` use `.ts` extensions; the worker uses `.js`.
- **Docker:** ffmpeg runs only in the worker container, and worker tests run there too: `docker compose run --rm worker pnpm --filter @digestor/worker test <pattern>`.
- **Concurrency is guarded in the database:**
  - Attribution writes run under `pg_advisory_xact_lock(hashtext(sessionId))`.
  - Job-owned rows (`find_more_requests`, `session_records`) are claimed with compare-and-set before sending, and are added to the sweep (R32).
  - `singletonKey` is never the guarantee.
- **Jobs:** every queue uses `JOB_OPTIONS` (create, update and send). Deterministic errors record a failure and return; transient errors rethrow, and only the final attempt fails the row.
- **LLM calls:** Claude 5.5 rules (no sampling parameters, `method: "jsonSchema"`). Output schemas are lenient; caps and checks live in code (`llm-structured-output` skill). New fakes follow a recorded real response (`vendor-contract-check` skill).
- **Copy:** user-facing errors are friendly sentences, and raw errors go to logs only. UI strings live in `apps/web/messages/en.ts`. Names carry `dir="auto"` and `lang` where known (`digestor-ui` skill).
- **Badges, exactly:**
  - `record` → "from record"
  - `caption` → "from caption"
  - `transcript` → "from transcript"
  - `metadata` → "from video details"
  - `human` → "from you"

  Fallback label: "Speaker {id}".
- **Values from the spec:**
  - `FOCUS_MIN_MS = 3_000`
  - caption frames: ≤ 6 per voice, ≤ 60 per session, turns ≥ 8 s, frames at +1 s and +4 s, 1280 px wide
  - Find more: shown below 5 moments; ≤ 40k tokens of transcript (≈ 160 000 characters)
  - eval score = `correct − 5 × wrong`
  - Who's who lists voices with ≥ `MIN_SPEAKER_SHARE` (0.1) of the words, the rest behind "Show N more voices"
- **The sensitive rule:** in a `sensitive` profile (`trial`), a name that isn't confirmed shows as "Speaker {id}" everywhere except Who's who.
- **Speaker names never go into subtitle cues or burned video.**
- **No AI text is rewritten when names change:** the "Names changed…" notice offers Re-analyse.
- **Commits:** only when the owner asks. When they do, end the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Human wins over AI re-runs.** After a human confirms a voice, a later AI write for the same voice (re-analysis, record fetch, caption re-run) must not change what shows. Test in Task 2 (`replaceAiAttributions never supersedes human rows`).
2. **Short interjections don't count.** A voice with one word ("Exato!") inside a clip must not block export or pass a focus filter. Test in Task 1 (`peopleInRange ignores voices under FOCUS_MIN_MS`) and Task 7.
3. **Trimming re-opens the speaker check.** A trim that pulls a new, unconfirmed voice into a clip must re-open the `speaker` item, and one that drops the voice must close it. Test in Task 7 (`speaker item follows the clip's bounds`).
4. **Accents and short forms.** "Flavio Bolsonaro" and "Flávio Bolsonaro" are one person; typing "Lula" offers "Luiz Inácio Lula da Silva" before creating a new person. Test in Task 1 (`normaliseName and closeMatches`).
5. **Sensitive profile.** A caption-proposed witness name in a `trial` session must not show on the Full briefing or in Prepare. Test in Task 5 (`speakerLabel hides unconfirmed names in sensitive profiles`).

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/attribution.ts` (new) | Client-safe types, `personAt`, `peopleInRange`, `turnsOf`, `normaliseName`, `closeMatches`, `speakerLabel`, `FOCUS_MIN_MS` |
| `packages/core/src/db/schema.ts` | Tables: `persons`, `attributions`, `session_records`, `find_more_requests`; `analysis_versions.names_at`; `moments.find_more_request_id` |
| `packages/core/drizzle/0007_*.sql`, `0008_*.sql`, `0009_*.sql` | Generated migrations |
| `packages/core/src/db/names.ts` (new) | Repo for persons and attributions |
| `packages/core/src/db/records.ts` (new) | Repo for `session_records` |
| `packages/core/src/db/personal.ts` | Find-more request repo functions |
| `packages/core/src/checklist.ts` | `speaker` item |
| `packages/core/src/queue.ts` | `moment.find_more`, `session.names` queues |
| `packages/core/src/recordRef.ts` (new) | `parseRecordRef` |
| `apps/worker/src/pipeline/naming.ts` (new) | Importing context names; the `name_speakers` node body |
| `apps/worker/src/agents/captions.ts` (new) | Frame plan, caption read, caption votes |
| `apps/worker/src/agents/findMore.ts` (new) | The Find more pass |
| `apps/worker/src/records/senado.ts`, `camara.ts`, `align.ts` (new) | Record clients and turn alignment |
| `apps/worker/src/llm/structured.ts`, `openrouter.ts` | Optional image input |
| `apps/web/app/api/sessions/[id]/names/route.ts`, `api/persons/route.ts`, `sessions/[id]/find-more/route.ts`, `sessions/[id]/record/route.ts` (new) | APIs |
| `apps/web/lib/names.ts` (new) | Who's who rows and display helpers |
| `apps/web/components/Names/SpeakerName.tsx`, `NamePopover.tsx`, `WhosWho.tsx` (new) | UI |

---

## Slice 1: Names everywhere

### Task 1: Attribution core (types and resolver)

**Files:**
- Create: `packages/core/src/attribution.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/src/attribution.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const FOCUS_MIN_MS = 3_000;
  export type AttributionSource = "record" | "caption" | "transcript" | "metadata" | "human";
  export type AttributionStatus = "proposed" | "confirmed" | "anonymous" | "rejected";
  export type AttributionEvidence =
    | { kind: "record"; speechId: string; score: number; url: string; fetchedAt: string }
    | { kind: "caption"; frameKey: string; text: string; atMs: number }
    | { kind: "quote"; quote: string }
    | { kind: "none" };
  export interface Person { id: string; displayName: string; fullName: string | null; kind: "official" | "custom";
    party: string | null; state: string | null; role: string | null; photoUrl: string | null; officialIds: Record<string, string> }
  export interface Attribution { id: string; sessionId: string; speakerId: string; startMs: number | null; endMs: number | null;
    personId: string | null; source: AttributionSource; status: AttributionStatus; confidence: number;
    evidence: AttributionEvidence; createdBy: string; createdAt: Date; supersededAt: Date | null }
  export type Resolution =
    | { kind: "named"; personId: string; confirmed: boolean; attribution: Attribution }
    | { kind: "anonymous"; attribution: Attribution }
    | { kind: "conflict"; attributions: Attribution[] }
    | { kind: "unnamed" };
  export interface Turn { speakerId: string; startMs: number; endMs: number; text: string }
  export function personAt(atts: Attribution[], speakerId: string, ms: number): Resolution;
  export function peopleInRange(words: Word[], atts: Attribution[], r: Range, minMs?: number):
    { speakerId: string; resolution: Resolution; ms: number }[];
  export function turnsOf(words: Word[]): Turn[];
  export function normaliseName(s: string): string;
  export function closeMatches(name: string, persons: Person[]): Person[];
  export function speakerLabel(res: Resolution, persons: ReadonlyMap<string, Person>, speakerId: string, sensitive: boolean):
    { text: string; badge: AttributionSource | null; proposed: boolean };
  ```

- [ ] **Step 1: Write the failing tests** in `attribution.test.ts`:
  - `personAt prefers human, then confirmed record, then a single proposed person`. Rows for voice "B":
    - whole transcript proposed P1 → `{kind:"named", personId:"P1", confirmed:false}`;
    - add a confirmed record row ranged 10–20 s for P2 → at 15 s it is P2 confirmed, at 5 s it is P1 proposed;
    - add a whole human row for P3 → P3 confirmed at every time;
    - add a human ranged anonymous row 30–40 s → `{kind:"anonymous"}` at 35 s.
  - `personAt treats superseded and rejected rows as absent`.
  - `personAt returns conflict when two proposed sources name different persons` (caption P1 and transcript P2 → `kind: "conflict"`, both attributions listed).
  - `peopleInRange ignores voices under FOCUS_MIN_MS`. Words: A speaks 0–10 s, B says one 500 ms word at 5 s; range 0–10 s → only A, with `ms` ≈ 10 000. With a range in which B speaks 4 s, B is included.
  - `turnsOf splits on speaker change and keeps text`: words A,A,B,A → 3 turns with exact bounds.
  - `normaliseName and closeMatches`:
    - `normaliseName("  Flávio  BOLSONARO.") === "flavio bolsonaro"`;
    - `closeMatches("Lula", [ {displayName:"Luiz Inácio Lula da Silva"}, {displayName:"Lulu Santos"} ])` returns only the first (every token of the query is a whole token of the candidate, or vice versa).
  - `speakerLabel shows the fallback for unnamed, anonymous and conflict` → `{text:"Speaker C", badge:null, proposed:false}`.
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test attribution`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `attribution.ts`.**
  - **`personAt`:** take the current rows (`supersededAt === null`, `status !== "rejected"`) for the voice that cover `ms`. A null range covers everything; a ranged row covers `startMs <= ms < endMs`. Then:
    1. **Human rows:** pick the ranged one first, then the latest `createdAt`. `anonymous` → anonymous, otherwise named and confirmed.
    2. **Confirmed `record` rows:** ranged first, then the highest confidence → named and confirmed.
    3. **Proposed rows:** distinct `personId`s > 1 → conflict. Exactly 1 → named and proposed, with the attribution chosen by source order `record > caption > transcript > metadata`.
    4. Otherwise unnamed.
  - **`peopleInRange`:** sums word durations inside `r` per (speakerId, resolution key: person id, `anon:<speaker>` or `none:<speaker>`), drops totals < `minMs` (default `FOCUS_MIN_MS`), and sorts by `ms` descending.
  - **`speakerLabel`:** named → the person's `displayName`, with badge = the attribution's source and `proposed = !confirmed`. When `sensitive && !confirmed`, or the resolution isn't named, it returns the fallback `Speaker ${speakerId}`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** (only if the owner has asked for commits in this run) `feat(core): attribution types and resolver`.

### Task 2: Persons and attributions tables and repo

**Files:**
- Modify: `packages/core/src/db/schema.ts`
  - `persons`: columns from the spec §5.1; `official_ids` jsonb; unique expression indexes on `(official_ids->>'senado')` and `(official_ids->>'camara')`; `name_norm` text, indexed, for search.
  - `attributions`: columns from §5.2; index `(session_id, speaker_id)`.
  - `analysisVersions.namesAt`: `timestamp("names_at", { withTimezone: true }).notNull().defaultNow()`.
- Create: migration via `pnpm --filter @digestor/core db:generate` (it becomes `0007_*.sql`)
- Create: `packages/core/src/db/names.ts`; Modify: `packages/core/src/server.ts` (export it)
- Test: `packages/core/src/db/names.test.ts` (uses the dev DB like `analysis.test.ts`)

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  ```ts
  export type NewAiAttribution = Pick<Attribution, "speakerId" | "startMs" | "endMs" | "personId" | "status" | "confidence" | "evidence">;
  export async function createCustomPerson(db: Db, a: { displayName: string; createdBy: string }): Promise<Person>;
  export async function upsertOfficialPerson(db: Db, p: { chamber: "senado" | "camara"; officialId: string; displayName: string;
    fullName?: string | null; party?: string | null; state?: string | null; role?: string | null; photoUrl?: string | null }): Promise<Person>;
  export async function findPersonByName(db: Db, name: string): Promise<Person | null>; // exact normaliseName match on display or full name
  export async function searchPersons(db: Db, q: string, limit?: number): Promise<Person[]>; // normalised substring, default 10
  export async function getPersons(db: Db, ids: string[]): Promise<Person[]>;
  export async function listAttributions(db: Db, sessionId: string): Promise<Attribution[]>; // current rows only
  export async function setHumanAttribution(db: Db, a: { sessionId: string; speakerId: string; startMs: number | null;
    endMs: number | null; personId: string | null; ownerId: string }): Promise<Attribution>; // personId null → anonymous
  export async function replaceAiAttributions(db: Db, sessionId: string, source: Exclude<AttributionSource, "human">,
    rows: NewAiAttribution[]): Promise<void>;
  export async function namesChangedAt(db: Db, sessionId: string): Promise<Date | null>;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `setHumanAttribution supersedes same-scope rows and keeps history`:
    - A whole human row for B, then another whole human row for B → `listAttributions` returns 1 row for B.
    - The raw table holds 2 rows, one with `superseded_at` set.
    - A ranged human row leaves the whole row current.
  - `replaceAiAttributions never supersedes human rows`:
    - Human whole row P3 for B; `replaceAiAttributions(…, "transcript", [B → P1 proposed])`; `personAt(listAttributions(...), "B", 0)` is P3.
    - Calling `replaceAiAttributions("transcript", [])` supersedes only the earlier transcript rows.
  - `replaceAiAttributions is idempotent`: calling it twice with the same rows leaves one current row per input.
  - `upsertOfficialPerson updates by official id`: the same senado id twice with a new party → one person with the new party.
  - `findPersonByName ignores accents and case`; `searchPersons finds by part of the name`.
  - `namesChangedAt` is null with only AI proposals, and set after a human row or a confirmed record row (including superseded ones).
  - `new analysis versions record names_at` (via `startAnalysisVersion`).
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test names`. Expected: FAIL.
- [ ] **Step 3: Implement `names.ts`.**
  - Every attribution write runs in `db.transaction` with `select pg_advisory_xact_lock(hashtext(${sessionId}))` first.
  - `setHumanAttribution`: supersedes the current rows for the voice with the same scope (both ranges null, or an equal `startMs`/`endMs`) and `source = 'human'`, then inserts with `status = personId ? "confirmed" : "anonymous"`, `confidence 1` and `evidence {kind:"none"}`.
  - `replaceAiAttributions`: supersedes the current rows with that `source`, then inserts `rows`.
  - `name_norm` = `normaliseName(displayName + " " + (fullName ?? ""))`.
- [ ] **Step 4: Generate the migration** with `pnpm --filter @digestor/core db:generate`, then run `pnpm db:migrate`. Expected: `0007_*.sql` creates both tables and the column; the migrate command exits 0.
- [ ] **Step 5: Run** the tests from Step 2, plus `pnpm --filter @digestor/core test`. Expected: PASS (the earlier 151 plus the new tests).
- [ ] **Step 6: Commit** `feat(core): persons and attributions with history`.

### Task 3: Context names become attributions; sufficiency reads them

**Files:**
- Create: `apps/worker/src/pipeline/naming.ts`
- Modify: `apps/worker/src/agents/context.ts`
  - `understandContext` input gains `named?: ReadonlySet<string>`;
  - `assessSufficiency(card, words, named?)`: a voice is identified if the card names it OR it is in `named`.
- Modify: `apps/worker/src/pipeline/graph.ts`
  - `understandContextNode`: before the call, `named` = voices whose whole-voice resolution is named or anonymous. Its `locked.participants` comes from `lockedParticipants(atts, persons)`. After saving the card it calls `importContextNames`.
  - `askContextNode`'s `applyCardEdits` no longer applies participant `name` edits; role and affiliation stay.
- Test: `apps/worker/src/pipeline/naming.test.ts`, `apps/worker/src/agents/context.test.ts`, `apps/worker/src/pipeline/graph.test.ts`

**Interfaces:**
- Consumes: Task 2 repo.
- Produces:
  ```ts
  export async function importContextNames(db: Db, sessionId: string, card: ContextCard): Promise<void>;
  export function lockedParticipants(atts: Attribution[], persons: Person[]): Participant[]; // confirmed names as human facts
  export function namedVoices(atts: Attribution[], speakerIds: string[]): Set<string>;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `importContextNames proposes grounded names with their source`:
    - card B `{value:"Flávio Bolsonaro", source:"video", evidence:"…"}` → a `transcript` attribution, proposed, evidence `{kind:"quote"}`, linked to a new custom person "Flávio Bolsonaro" (`createdBy "transcript"`);
    - `source:"metadata"` → a `metadata` row;
    - `source:"human"` (from the hint or an answer) → a `transcript` proposed row with the hint quote. It is still a proposal: humans confirm in Who's who.
    - A second call reuses the same person (`findPersonByName`) and doesn't duplicate rows.
  - `assessSufficiency counts voices named elsewhere`: a card without names and `named = {"A","B"}` → no participant questions.
  - `graph: a confirmed human name survives a second context round`: a human attribution for A before resume → round 2 card's participants include A's name as a human fact, and no participant question for A.
- [ ] **Step 2: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test naming context graph`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as described in Files. Existing graph tests that edit participant names through `cardEdits` change to create human attributions with `setHumanAttribution` before resuming.
- [ ] **Step 4: Run** the same command, then `pnpm test:worker`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): context names become attributions`.

### Task 4: Names API

**Files:**
- Create: `apps/web/app/api/sessions/[id]/names/route.ts`, `apps/web/app/api/persons/route.ts`
- Test: `apps/web/app/api/names.test.ts` (harness as in `misc.test.ts`)

**Interfaces:**
- Consumes: Task 2 repo.
- Produces:
  - `GET /api/sessions/[id]/names` → `{ persons: Person[]; attributions: Attribution[] }`, where `persons` holds every person referenced.
  - `POST /api/sessions/[id]/names`, with body (zod, `.strict()`):
    ```ts
    | { action: "assign"; speakerId: string; personId: string; startMs?: number; endMs?: number }
    | { action: "create"; speakerId: string; displayName: string; startMs?: number; endMs?: number }
    | { action: "anonymous"; speakerId: string; startMs?: number; endMs?: number }
    | { action: "confirm"; speakerId: string }  // human row for the whole voice, with the currently resolved person
    | { action: "confirm_all" }                 // confirm for every voice whose whole-voice resolution is named and proposed
    ```
    → 200 with the same body as GET.
  - `GET /api/persons?q=` → `{ persons: Person[] }` (≤ 10).

- [ ] **Step 1: Write the failing tests:**
  - `names: assign, create, anonymous and confirm write human rows` (each returns the new state; `create` with "Lula" reuses an existing person from `findPersonByName`);
  - `names: confirm_all confirms only proposed single-person voices` (a conflict voice stays unconfirmed);
  - `names: a range needs both ends and start < end` → 400 "Send both start and end, with start before end.";
  - `names: 409 before the transcript exists` → "Names can be set once the transcript is ready.";
  - `names: unknown session` → 404 "Session not found.";
  - `persons: search returns at most 10 and needs 2+ characters` (1 character → `{ persons: [] }`).
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test names`. Expected: FAIL.
- [ ] **Step 3: Implement both routes** following `sessions/[id]/context/route.ts`: `isUuid`, `errorResponse` and `getServer()`, with `OWNER_ID` as `ownerId` and `createdBy`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): names API`.

### Task 5: Names on every screen (`SpeakerName` and the popover)

**Files:**
- Create: `apps/web/lib/names.ts`, `apps/web/components/Names/SpeakerName.tsx`, `apps/web/components/Names/NamePopover.tsx`
- Modify: `apps/web/messages/en.ts` (a `names` section: the badges from Global Constraints, "Confirm", "Change…", "No name", "Only this part", "New person", "Speaker {id}")
- Modify: the places that render `t("briefing.speaker", { id })` or speaker ids: `components/Briefing/MomentRow.tsx`, `Briefing/Controls.tsx` (labels only, filter in Task 9), `Preview/Preview.tsx` (header "N speakers · M named"), `Preview/TopHighlights.tsx`, `Preview/Timeline.tsx` (tooltip), `Preview/BriefingDoc.tsx`, `Prepare/PrepareList.tsx`, `ExportList.tsx`; the pages `app/s/[id]/page.tsx`, `briefing/page.tsx`, `prepare/page.tsx`, `export/page.tsx` load `listAttributions` + `getPersons` and pass `names: { persons; attributions }` down.
- Test: `apps/web/lib/names.test.ts`

**Interfaces:**
- Consumes: Task 1 `speakerLabel`, `personAt`, `peopleInRange`; Task 4 API.
- Produces:
  ```ts
  export interface NamesData { persons: Person[]; attributions: Attribution[] }
  export function voiceLabel(names: NamesData, speakerId: string, atMs: number, sensitive: boolean): ReturnType<typeof speakerLabel>;
  export function momentPeople(names: NamesData, words: Word[], r: Range, sensitive: boolean):
    { speakerId: string; label: ReturnType<typeof speakerLabel>; ms: number }[];
  export function badgeText(source: AttributionSource): string; // the exact badge copy
  ```
  - `<SpeakerName speakerId atMs names sensitive sessionId range? />` renders the label, the badge and a dotted underline when `proposed`. Clicking it opens `NamePopover`.
  - `<NamePopover>` posts to `/api/sessions/[id]/names` and calls `router.refresh()`.

- [ ] **Step 1: Write the failing tests** in `names.test.ts`:
  - `voiceLabel names a confirmed person with its badge`;
  - `speakerLabel hides unconfirmed names in sensitive profiles` (caption-proposed P1 with `sensitive: true` → "Speaker C"; confirmed → the name);
  - `momentPeople lists people in the moment, most speaking time first, without interjections`;
  - `badgeText matches the spec copy` (all five strings, exactly).
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test names`. Expected: FAIL.
- [ ] **Step 3: Implement `lib/names.ts` and the two components**, then replace every speaker-id label in the listed files.
  - **Popover:** a Base UI popover (as used elsewhere) with the actions Confirm / Change… (a combobox over `/api/persons?q=`, showing `closeMatches` first and "New person: <typed>") / No name / Only this part. *Only this part* is shown when a `range` prop is passed and sends `startMs`/`endMs`.
  - **Keyboard:** Escape closes, and focus returns to the trigger.
  - **Tooltip:** hovering the badge shows the evidence line (§8.1 of the spec).
- [ ] **Step 4: Run** `pnpm --filter @digestor/web test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: See it (digestor-run skill).**
  - Open the debate session `7433d1c6` at 1280 and 390 px: Preview header, a briefing row, Prepare, Export. Expected: Tralli / Flávio Bolsonaro / Luiz Inácio Lula da Silva with the "from transcript" or "from you" badge, the popover works, and `errors.txt` is empty.
  - The debate's existing card names must have been imported first: run `importContextNames` once for that session with a throwaway `tsx` one-liner in the worker container, then delete it.
- [ ] **Step 6: Commit** `feat(web): speaker names with sources on every screen`.

### Task 6: Who's who panel

**Files:**
- Create: `apps/web/components/Names/WhosWho.tsx`
- Modify: `apps/web/components/ContextCheck.tsx` (its participant name fields are replaced by `<WhosWho>`; role and affiliation fields stay), `apps/web/lib/contextPayload.ts` (no participant names in `cardEdits`), `components/Preview/Preview.tsx` (the header speaker count opens the drawer), `components/Briefing/FullBriefing.tsx` (a "Who's who" button opens the drawer)
- Modify: `apps/web/lib/names.ts` and its test
- Test: `apps/web/lib/names.test.ts`, `apps/web/lib/contextPayload.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces: `export function whosWhoRows(names: NamesData, words: Word[]): { speakerId: string; resolution: Resolution; ms: number; share: number; sampleStartMs: number; main: boolean }[]`.
  - It groups each word by (voice, `personAt` at that word).
  - `main` = the voice's share ≥ 0.1 (`MIN_SPEAKER_SHARE`).
  - `sampleStartMs` is the first turn ≥ 8 s of that group, or else its first word.
  - Rows are sorted by `ms` descending.

- [ ] **Step 1: Write the failing tests:**
  - `whosWhoRows splits a voice the record named as two people` (a ranged record row for B's second turn → two rows for B);
  - `whosWhoRows marks voices under 10% as not main`;
  - `buildContextPayload no longer sends participant names` (it still sends role and affiliation).
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test names contextPayload`. Expected: FAIL.
- [ ] **Step 3: Implement `whosWhoRows` and `<WhosWho sessionId words names profile mode="context" | "drawer">`.**
  - **Each row:** a ▶ sample (the same hidden proxy player pattern as `ContextCheck.hear`), `SpeakerName` with `sensitive=false`, the evidence (the caption frame thumbnail via `/api/files/<sessionId>/names/...`, the record match line or the quote), and Confirm / Change / No name.
  - **Above the rows:** "Confirm all proposed". Rows that aren't main sit behind "Show N more voices".
  - **Sensitive profiles:** the panel shows the line "AI-proposed names stay hidden outside this panel until you confirm them."
  - **Drawer:** the existing Sheet or drawer component. Changes apply through Task 4 and refresh the page.
- [ ] **Step 4: Run** `pnpm --filter @digestor/web test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: See it.** Seed a session at the context check (`seed-demo.ts --stage awaiting_context`), then use the debate session's drawer: confirm all, rename one, mark one "No name". Screenshots at 1280 and 390 px; `errors.txt` empty.
- [ ] **Step 6: Commit** `feat(web): Who's who panel`.

### Task 7: The `speaker` export check and the "names changed" notice

**Files:**
- Modify: `packages/core/src/checklist.ts`:
  - `ChecklistId` adds `"speaker"`.
  - `exportChecklist` gains `a.speakers: { speakerId: string; resolution: Resolution; ms: number }[]`, which the caller computes with `peopleInRange(words, atts, clip)`.
- Modify: the callers `apps/web/app/s/[id]/export/page.tsx`, `apps/web/app/api/sessions/[id]/export/route.ts`, `apps/web/components/Prepare/PrepareList.tsx`, `components/Prepare/ChecksPanel.tsx` (failing copy "Speaker C is not confirmed" with a "Confirm names" button that opens `NamePopover`)
- Modify: `apps/web/messages/en.ts`
- Modify: `components/Preview/Preview.tsx` and `Briefing/FullBriefing.tsx` show the notice when `namesChangedAt > version.namesAt`.
- Test: `packages/core/src/checklist.test.ts`, `apps/web/app/api/export.test.ts`

**Interfaces:**
- Consumes: Task 1 `peopleInRange`; Task 2 `namesChangedAt`, `analysisVersions.namesAt`.
- Produces: the `speaker` item is ok iff every entry's resolution is (named and confirmed) or anonymous. It ignores `warningsAck`.

- [ ] **Step 1: Write the failing tests:**
  - `speaker item passes only for confirmed or anonymous voices` (proposed → not ok, even with `warningsAck: true`; conflict → not ok; unnamed → not ok);
  - `speaker item follows the clip's bounds`. Using `peopleInRange` on bounds 0–10 s, then trimmed to 0–20 s where unconfirmed C speaks 6 s → it fails; trimmed back → it passes;
  - `export route refuses a clip with an unconfirmed speaker` (409, `failing` includes `"speaker"`).
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test checklist` and `pnpm --filter @digestor/web test export`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The export route and pages load the attributions and the transcript words once per request.
  - **The notice copy:** "Names changed after this analysis was written. AI text may use earlier names." with a **Re-analyse** link to the existing re-analysis flow.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: See it.** In the debate session, Prepare and Export a clip: blocked while Lula is proposed, unblocked after Confirm.
- [ ] **Step 6: Commit** `feat: export needs confirmed speakers`.

### Task 8: Attribution metric and the debate's golden speakers

**Files:**
- Modify: `apps/worker/src/eval/metrics.ts`
  - `Golden` gains `speakers?: { startMs: number; endMs: number; person: string | null }[]`.
  - Add `attributionScore`.
- Modify: `apps/worker/scripts/eval.ts`: prints the rows "Speaking time named correctly / wrongly / unnamed" and "Attribution score", twice: "AI only" (rows whose source isn't human) and "as stored".
- Modify: `apps/worker/eval/globo-debate-2026-10-23.golden.json`
  - Add `speakers`: turn spans from the transcript's diarization (A Tralli → "César Tralli", B → "Flávio Bolsonaro", C → "Luiz Inácio Lula da Silva").
  - Check the spans against the transcript text; a stretch where the diarization is wrong gets the right person, or `null` when it's unclear.
  - Set `labelledBy` to "…speakers drafted by Claude; owner review pending".
- Test: `apps/worker/src/eval/metrics.test.ts`

**Interfaces:**
- Consumes: Task 1 `personAt`, `normaliseName`.
- Produces: `export function attributionScore(golden: NonNullable<Golden["speakers"]>, words: Word[], atts: Attribution[], persons: Person[]): { correctMs: number; wrongMs: number; unnamedMs: number; totalMs: number; correctConfirmedMs: number; score: number }`, where `score = (correctMs − 5 × wrongMs) / totalMs`. Names compare by `normaliseName` against the person's display or full name. `null` golden spans are skipped, and a conflict counts as unnamed.

- [ ] **Step 1: Write the failing tests:** `attributionScore weights wrong names five times` (10 s correct, 2 s wrong, 3 s unnamed → score (10 − 10) / 15 = 0) and `attributionScore skips null spans and treats conflict as unnamed`.
- [ ] **Step 2: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test metrics`. Expected: FAIL.
- [ ] **Step 3: Implement** the metric and the `eval.ts` rows; label the golden speakers.
- [ ] **Step 4: Run** the tests, then the eval on `7433d1c6` (CLAUDE.md command). Expected: PASS, and the table shows both attribution blocks.
- [ ] **Step 5: Commit** `feat(eval): attribution metric; debate speakers labelled`. Ask the owner to review the speaker labels.

## Slice 2: Focus by person and Find more

### Task 9: Focus by person

**Files:**
- Modify: `apps/web/lib/briefingFilters.ts`:
  - `BriefingFilters` adds `person: string | null`. It sits beside `speaker`, and the two are exclusive: setting one clears the other.
  - URL `p=`. `fromSearchParams` takes `known.persons`.
  - `passesContent(m, status, f, ctx)` gets `ctx: { names: NamesData; words: Word[] }` for the person check.
- Modify: `apps/web/lib/briefingData.ts` (`speakerOptions` → `focusOptions(names, words)`: persons by speaking share, then unnamed voices); `components/Briefing/Controls.tsx` (the picker lists the options with `SpeakerName` labels); `app/s/[id]/briefing/page.tsx`
- Test: `apps/web/lib/briefingFilters.test.ts`, `apps/web/lib/briefingData.test.ts`

**Interfaces:**
- Consumes: Task 1 `peopleInRange`; Task 5 `NamesData`.
- Produces: `export function focusOptions(names: NamesData, words: Word[]): ({ kind: "person"; personId: string; share: number } | { kind: "voice"; speakerId: string; share: number })[]`.

- [ ] **Step 1: Write the failing tests:**
  - `person focus keeps moments where the person speaks at least 3 s`;
  - `person focus follows ranged record names across voices` (P is voice B in turn 1 and voice D in turn 5 → both moments pass);
  - `p= round-trips through the URL and an unknown person falls back to everyone`;
  - `focusOptions lists persons by share, then unnamed voices`.
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test briefingFilters briefingData`. Expected: FAIL.
- [ ] **Step 3: Implement.** Precompute per moment `peopleInRange` once (`useMemo` keyed on the moments and attributions) so the filters stay instant.
- [ ] **Step 4: Run** `pnpm --filter @digestor/web test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): focus by person`.

### Task 10: Find more moments with <name>

**Files:**
- Modify: `packages/core/src/db/schema.ts`:
  - `find_more_requests`: `id`, `owner_id`, `analysis_id` (fk cascade), `person_id` (fk), `status` `pending|running|done|failed`, `error` text null, `moment_count` int default 0, `created_at`, `updated_at`; unique `(owner_id, analysis_id, person_id)`.
  - `moments.find_more_request_id` uuid null (fk cascade).
  - Migration `0008_*.sql`.
- Modify: `packages/core/src/analysisTypes.ts` (`MomentOrigin` adds `"find_more"`), `apps/web/lib/briefingFilters.ts` (`isPersonal` includes it), `packages/core/src/queue.ts` (`QUEUES.findMore = "moment.find_more"`, `FindMoreJobSchema = z.object({ requestId: z.string().uuid() })`)
- Modify: `packages/core/src/db/personal.ts` (the repo below)
- Create: `apps/worker/src/agents/findMore.ts`; Modify: `apps/worker/src/jobs.ts` (`handleFindMore`), `apps/worker/src/main.ts` (register the queue), `apps/worker/src/sweep.ts` (stuck `pending`/`running` rows older than 30 min with no live `moment.find_more` job matched on `requestId` → `failed`, `STUCK_MESSAGE`)
- Create: `apps/web/app/api/sessions/[id]/find-more/route.ts`; Modify: `components/Briefing/FullBriefing.tsx` (the button, the "Finding…" state, the inline error, "No new moments found.", the "Found for you" marker)
- Test: `packages/core/src/db/personal.test.ts`, `apps/worker/src/agents/findMore.test.ts`, `apps/worker/src/jobs.test.ts`, `apps/worker/src/sweep.test.ts`, `apps/web/app/api/personal.test.ts`

**Interfaces:**
- Consumes: Task 1 `turnsOf`, `personAt`, `FOCUS_MIN_MS`; the moments agent's `MomentsOutput` and `normalizeMoments` (export them if they aren't already).
- Produces:
  ```ts
  // personal.ts
  export async function requestFindMore(db: Db, a: { ownerId: string; analysisId: string; personId: string }): Promise<FindMoreRequest | null>; // null while one is pending/running
  export async function claimFindMore(db: Db, id: string): Promise<boolean>; // pending → running
  export async function finishFindMore(db: Db, id: string, moments: NewMoment[]): Promise<number>; // replaces this request's earlier moments; status done
  export async function failFindMore(db: Db, id: string, message: string): Promise<void>;
  export async function getFindMore(db: Db, a: { ownerId: string; analysisId: string; personId: string }): Promise<FindMoreRequest | null>;
  // findMore.ts
  export const FIND_MORE_MAX_CHARS = 160_000;
  export const MAX_FIND_MORE_MOMENTS = 20;
  export async function findMoreMoments(llm: StructuredLLM, a: { card: ContextCard; transcript: Transcript; topics: Topic[];
    personTurns: Range[]; personName: string }): Promise<NewMoment[]>;
  ```
  - `POST /api/sessions/[id]/find-more` `{ personId }` → 202 `{ status: "pending" }`, or 409 "Already looking for more moments with this person." while one runs.
  - `GET /api/sessions/[id]/find-more?personId=` → `{ status, momentCount, error }`.

- [ ] **Step 1: Write the failing tests:**
  - `findMoreMoments sends only the person's turns with 30 s around them, capped` (FakeLLM call user text holds those turns and nothing else; a 3-hour person stays ≤ `FIND_MORE_MAX_CHARS`);
  - `findMoreMoments drops moments where the person speaks under 3 s and keeps at most 20`;
  - `finishFindMore replaces this person's earlier find-more moments only` (another person's and Ask's personal moments stay);
  - `requestFindMore returns null while one is pending or running` (re-request after `done` resets it to `pending`);
  - `handleFindMore`: a missing key fails the row and doesn't rethrow; a transient error rethrows and only the final attempt fails the row;
  - `sweep fails a stuck find-more request`;
  - the route: 202 and one send of `QUEUES.findMore` with `JOB_OPTIONS`; 409 while running; a failed send → the row goes back to failed with "Couldn't queue the job. Please try again." and the route answers 503.
- [ ] **Step 2: Run** the core, worker and web test patterns above. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The call:** one `reasoning` call, reusing the moment rubric (`buildMomentsPrompt`'s system rules with all three granularities allowed). The user text lists the person's merged windows, each window's transcript and the line `Focus person: <name>`.
  - **Moments:** `origin "find_more"`, `ownerId OWNER_ID`, `findMoreRequestId` = the request id.
  - **The UI:** the button shows under the list when focus is on a person and fewer than 5 moments pass the filters, and also in the focus picker's menu. It polls the GET route (`lib/refreshLoop.ts`) while it's pending or running.
- [ ] **Step 4: Run** `pnpm test`, `pnpm test:worker` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: See it** on the debate: focus on Tralli and click Find more. Expected: "Finding…", then new rows marked "Found for you", and `errors.txt` empty. Note the cost (about $0.03).
- [ ] **Step 6: Commit** `feat: find more moments with a person`.

## Slice 3: Captions

### Task 11: Image input for `StructuredLLM`

**Files:**
- Modify: `apps/worker/src/llm/structured.ts`:
  - `generate` args gain `images?: { mediaType: "image/jpeg" | "image/png"; data: string }[]` (base64).
  - `invokeWithOneRetry` builds a human message with content parts when images are present.
  - `FakeLLM` records `images` count on `FakeCall`.
- Modify: `apps/worker/src/llm/openrouter.ts` (the same, in OpenAI-style content parts)
- Create: `apps/worker/test/fixtures/vision-caption-anthropic.json`, `vision-caption-openrouter.json` (recorded)
- Test: `apps/worker/src/llm/structured.test.ts`, `apps/worker/src/llm/openrouter.test.ts`

**Interfaces:**
- Produces: the `generate` signature above. A call without images is byte-for-byte unchanged on the wire (existing wire tests stay green).

- [ ] **Step 1: Record the real responses** (vendor-contract-check skill).
  - In the worker container, extract one frame of the debate with a lower third (`docker compose exec worker ffmpeg -ss 00:13:58 -i /data/7433d1c6-458e-42b8-898c-2d92583a9f03/original.mp4 -frames:v 1 -vf scale=1280:-2 /data/caption-probe.jpg`).
  - Send one structured call per provider with a throwaway script.
  - Save the request shape and the response as fixtures. Delete the frame and the script afterwards.
  - Confirm the image content-part format each provider accepts through LangChain **[unverified in the spec]**.
- [ ] **Step 2: Write the failing tests:** `anthropic adapter sends the image as a content part next to the text` and `openrouter adapter sends image_url data parts`, each asserting the exact request body shape from the fixtures via `fakeFetch`, plus `no images: request body unchanged`.
- [ ] **Step 3: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test structured openrouter`. Expected: FAIL.
- [ ] **Step 4: Implement** the adapters.
- [ ] **Step 5: Run** the same command and `pnpm test:worker`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(worker): images in structured LLM calls`.

### Task 12: Caption reading and the `name_speakers` node

**Files:**
- Create: `apps/worker/src/agents/captions.ts`
- Modify: `apps/worker/src/media/ffmpeg.ts` (`frame(input, atMs, output, width)`; `thumbnail` calls it with 640)
- Modify: `apps/worker/src/pipeline/naming.ts` (`nameSpeakersNode`), `apps/worker/src/pipeline/graph.ts` (node `name_speakers` between `transcribe` and `understand_context`, through `unlessFailed`)
- Modify: the stage `naming_speakers`, with progress 50 and the label "Naming speakers":
  - `packages/core/src/schemas.ts` (`Stage`), `apps/worker/src/sweep.ts` (`IN_PROGRESS`), `apps/worker/src/cleanup.ts` (`PROCESSING_STAGES`), `apps/web/lib/processingSteps.ts`, `apps/web/messages/en.ts`
- Modify: `packages/core/src/cost.ts` (`estimateCostUsd(durationMs, opts: { captions?: boolean } = {})` adds `CAPTIONS_USD = 0.10` when `captions`), plus its callers
- Modify: `apps/worker/src/pipeline/fakeAnalysis.ts` (a `captions` responder)
- Test: `apps/worker/src/agents/captions.test.ts`, `apps/worker/src/pipeline/graph.test.ts`, `packages/core/src/cost.test.ts` (or the existing cost test location)

**Interfaces:**
- Consumes: Task 11 images; Task 2 `replaceAiAttributions`, `findPersonByName`, `createCustomPerson`.
- Produces:
  ```ts
  export const CAPTION_MIN_TURN_MS = 8_000, CAPTION_FRAMES_PER_VOICE = 6, CAPTION_MAX_FRAMES = 60, CAPTION_WIDTH = 1280;
  export function captionFramePlan(words: Word[]): { speakerId: string; atMs: number }[];
  export const CaptionOutput: z.ZodType<{ captionText: string; personName: string; partyOrRole: string }>; // "" = none
  export async function readCaption(llm: StructuredLLM, image: { mediaType: "image/jpeg"; data: string }): Promise<{ text: string | null; name: string | null; partyOrRole: string | null }>;
  export function captionVotes(reads: { speakerId: string; atMs: number; frameKey: string; name: string | null; text: string | null }[]):
    { speakerId: string; name: string; frameKey: string; text: string; atMs: number; agreeing: number; total: number }[];
  export const nameSpeakersNode: (deps: PipelineDeps) => Node; // in naming.ts
  ```

- [ ] **Step 1: Write the failing tests:**
  - `captionFramePlan takes up to 3 long turns per voice, frames at +1 s and +4 s, longest voices first, 60 at most`;
  - `captionVotes needs the same name in 2 frames of a voice and no other name` (1 frame → none; 2 agreeing → a proposal; 2 + 1 different → none; accents ignored via `normaliseName`);
  - `readCaption treats empty strings as none and keeps the prompt's rule` (system contains "Read only text visible in the image; never guess.");
  - `graph: name_speakers writes caption proposals and is idempotent` (FakeLLM captions; run the node twice → one current caption row per voice);
  - `graph: audio-only or a deleted original skips captions` (no `captions` calls);
  - `graph: a caption failure doesn't fail the session` (the node logs and continues);
  - `estimateCostUsd adds captions for video`.
- [ ] **Step 2: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test captions graph` and `pnpm --filter @digestor/core test cost`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Frames go in `<sessionId>/names/<speakerId>-<atMs>.jpg`.
  - The vision calls use `fast`, with `PASS_CONCURRENCY` 4.
  - **Each vote:**
    - with `findPersonByName`, reuse the person;
    - otherwise `createCustomPerson({ createdBy: "caption" })`.
  - **The row:** `replaceAiAttributions("caption", …)` with status `proposed`, `confidence = agreeing / total` and evidence `{kind:"caption", frameKey, text, atMs}`.
  - **The node:** sets the stage `naming_speakers` (50), and a `MissingApiKeyError` fails the session (Ruling R8, as in the other nodes).
- [ ] **Step 4: Run** the same commands, `pnpm test`, `pnpm test:worker` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Measure on the debate.** Run the caption step alone for `7433d1c6` (a throwaway script calling `nameSpeakersNode`'s caption function) and check the proposals against the golden speakers. Record the calls, the cost and the result in the task notes, and delete the script.
- [ ] **Step 6: Commit** `feat(worker): names from on-screen captions`.

## Slice 4: Senado record

### Task 13: Senado client

**Files:**
- Create: `apps/worker/src/records/senado.ts`, fixtures `apps/worker/test/fixtures/senado-discursos-<date>.json` and `senado-senador-<codigo>.json` (recorded)
- Test: `apps/worker/src/records/senado.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RecordSpeech { id: string; order: number; officialId: string; name: string; party: string | null; state: string | null; text: string }
  export async function fetchSenadoSpeeches(date: string, sessionCode: string | null, f?: typeof fetch): Promise<RecordSpeech[]>;
  export async function fetchSenador(codigo: string, f?: typeof fetch): Promise<{ officialId: string; displayName: string; fullName: string | null; party: string | null; state: string | null; photoUrl: string | null }>;
  export class RecordNotFoundError extends Error {}
  ```

- [ ] **Step 1: Make the real calls** (from the host or the worker container):
  - `GET https://legis.senado.leg.br/dadosabertos/plenario/lista/discursos/{ini}/{fim}.json` for a recent plenary day;
  - `GET https://legis.senado.leg.br/dadosabertos/senador/{codigo}.json`.

  Save trimmed payloads as fixtures. Write down:
  - whether a speech carries a session code (used for `sessionCode` filtering) **[unverified]**;
  - where the full text and the order live;
  - the photo URL field.
- [ ] **Step 2: Write the failing tests** against the fixtures:
  - `fetchSenadoSpeeches parses speeches in order with speaker codes and text`;
  - `fetchSenadoSpeeches filters to the session when a code is given`;
  - `fetchSenador parses name, party, UF and photo`;
  - `an empty day throws RecordNotFoundError`;
  - `a 5xx rethrows as a plain error` (transient).
- [ ] **Step 3: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test senado`. Expected: FAIL.
- [ ] **Step 4: Implement** with zod schemas built from the fixtures (lenient: unknown fields pass through, and missing optional fields become null).
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(worker): Senado speeches client`.

### Task 14: Turn alignment

**Files:**
- Create: `apps/worker/src/records/align.ts`
- Test: `apps/worker/src/records/align.test.ts`

**Interfaces:**
- Consumes: Task 1 `Turn`; Task 13 `RecordSpeech`.
- Produces:
  ```ts
  export const RECORD_CONFIRM = 0.6, RECORD_PROPOSE = 0.35; // starting values; Task 16 tunes them
  export function similarityMatrix(turns: Turn[], speeches: RecordSpeech[]): number[][]; // TF-IDF cosine over normalised Portuguese tokens
  export function alignTurns(sim: number[][]): { turn: number; speech: number; score: number }[];
  export function recordAttributions(turns: Turn[], speeches: RecordSpeech[], matches: ReturnType<typeof alignTurns>,
    personIdFor: (officialId: string) => string, ref: { url: string; fetchedAt: string }): NewAiAttribution[];
  ```

- [ ] **Step 1: Write the failing tests.** The synthetic transcript is built from the Senado fixture's texts, split into turns.
  - `alignTurns keeps speeches in order and lets a long speech span turns`;
  - `alignTurns skips turns that match nothing` (apartes and chair lines inserted);
  - `alignTurns handles a missing speech` (one record speech has no turn);
  - `recordAttributions confirms above RECORD_CONFIRM, proposes between the thresholds, drops below`;
  - `recordAttributions writes ranged rows on the turn's bounds, even when two senators share a voice id`.
- [ ] **Step 2: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test align`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Tokens:** `normaliseName`-style lowercasing, no accents, words of length ≥ 3, and a short Portuguese stop-word list in the file.
  - **The alignment** is a monotonic DP:
    ```
    best[i][j] = max score aligning turns 0..i-1 with speeches 0..j-1, where turn i-1 is unassigned or assigned to speech j-1
    best[i][j] = max( best[i-1][j]                      // turn i-1 skipped
                    , best[i-1][j] + sim[i-1][j-1]      // turn i-1 continues speech j-1 (only if turn i-2 was on j-1 or j-1 starts here)
                    , best[i-1][j-1] + sim[i-1][j-1]    // turn i-1 starts speech j-1
                    , best[i][j-1] )                    // speech j-1 skipped
    ```
  - Only matches with `sim ≥ RECORD_PROPOSE` count, so there's no gain from weak matches. Backtrack to recover the matches.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): align transcript turns to record speeches`.

### Task 15: Linking a record and the `session.names` job

**Files:**
- Create: `packages/core/src/recordRef.ts` (client-safe, exported from `index.ts`), `packages/core/src/db/records.ts` (exported from `server.ts`)
- Modify: `packages/core/src/db/schema.ts`:
  - `session_records`: `session_id` pk/fk cascade, `chamber`, `ref` jsonb, `status` `pending|running|matched|failed`, `error`, `raw_key`, `fetched_at`, `updated_at`.
  - Migration `0009_*.sql`.
- Modify: `packages/core/src/queue.ts` (`QUEUES.names = "session.names"`, `NamesJobSchema = z.object({ sessionId: z.string().uuid() })`)
- Modify: `apps/worker/src/pipeline/naming.ts` (`runRecordStep(deps, sessionId)`, called first in `nameSpeakersNode` when a record row exists), `apps/worker/src/jobs.ts` (`handleNames`), `apps/worker/src/main.ts`, `apps/worker/src/sweep.ts` (stuck `pending`/`running` > 30 min with no live `session.names` job on `sessionId` → `failed`)
- Create: `apps/web/app/api/sessions/[id]/record/route.ts`
- Modify: `components/UploadForm.tsx` (an optional "Official record" field, "Senado or Câmara session link"), `app/api/sessions/upload/route.ts` and `youtube/route.ts` (they store it via `linkRecord`), `components/Names/WhosWho.tsx` (the field for `parliament`, the status line "Matching the official record…", "Names from the Senado record of <date>", or the friendly error)
- Test: `packages/core/src/recordRef.test.ts`, `packages/core/src/db/records.test.ts`, `apps/worker/src/jobs.test.ts`, `apps/worker/src/sweep.test.ts`, `apps/worker/src/pipeline/graph.test.ts`, `apps/web/app/api/names.test.ts`

**Interfaces:**
- Consumes: Tasks 13 and 14; Task 2 `upsertOfficialPerson`, `replaceAiAttributions`.
- Produces:
  ```ts
  export type RecordRef = { chamber: "senado"; date: string; sessionCode: string | null; url: string } | { chamber: "camara"; eventId: string; url: string };
  export function parseRecordRef(input: string): RecordRef | null; // URL shapes confirmed live in Step 1
  export async function linkRecord(db: Db, sessionId: string, ref: RecordRef): Promise<void>; // upsert, status pending
  export async function claimRecordFetch(db: Db, sessionId: string): Promise<SessionRecord | null>; // pending → running
  export async function finishRecordFetch(db: Db, sessionId: string, a: { rawKey: string }): Promise<void>; // matched
  export async function failRecordFetch(db: Db, sessionId: string, message: string): Promise<void>;
  export async function getSessionRecord(db: Db, sessionId: string): Promise<SessionRecord | null>;
  ```
  - `POST /api/sessions/[id]/record` `{ ref: string }` → 202. When the transcript exists, it enqueues `session.names`; otherwise `name_speakers` picks the record up. A ref it can't parse → 400 "Paste a Senado or Câmara session link."
  - **A plan decision:** linking during the context pause runs this job instead of re-running the graph node. Names arrive while paused and Who's who polls for them (spec §6.1's intent, without a new graph branch).

- [ ] **Step 1: Confirm the URL shapes.**
  - Open a Senado plenary session page and a Câmara event page, and note their URL patterns **[unverified]**.
  - Write them into `parseRecordRef`'s tests as the accepted examples.
  - A plain date (`2026-10-21`) means Senado.
- [ ] **Step 2: Write the failing tests:**
  - `parseRecordRef accepts the confirmed Senado and Câmara URLs and a date, rejects others`;
  - `claimRecordFetch claims once`;
  - `handleNames matches the record and writes confirmed ranged rows with official persons` (fake fetch with the Task 13 fixtures; a synthetic transcript);
  - `handleNames: no speeches → failed with "The Senado has no speeches for that date."`, no rethrow;
  - `handleNames: a 5xx rethrows until the final attempt, then failed with "The Senado record couldn't be fetched. Please try again."`;
  - `handleNames never supersedes human rows`;
  - `sweep fails a stuck record fetch`;
  - `graph: name_speakers runs the record step when a record is linked at upload`;
  - `record route: 202 and one send; 400 for a bad ref; a Câmara ref while unsupported → 422 "Câmara records aren't supported yet."` (until Task 17).
- [ ] **Step 3: Run** the core, worker and web patterns above. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **Storage:** keep the raw payload under `<sessionId>/names/record.json`.
  - **Persons:** upsert each matched senator with `fetchSenador`, cached per job.
  - **The row:** `replaceAiAttributions("record", …)` with evidence `{kind:"record", speechId, score, url, fetchedAt}`.
- [ ] **Step 5: Run** `pnpm test`, `pnpm test:worker` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: names from the Senado record`.

### Task 16: Tune on a real Senado session (needs the owner)

**Files:**
- Modify: `apps/worker/src/records/align.ts` (thresholds), `apps/worker/eval/senado-<date>.golden.json` (new: 30 labelled turns plus topics, if time allows), `README.md` (Evaluation: attribution results)

- [ ] **Step 1: Ask the owner** for a Senado plenary session to use: a TV Senado YouTube link, or a file in `data/`, ideally 1–2 h with many speakers. Upload it through the app with the record link.
- [ ] **Step 2: Measure diarization** (spec §6.3): the voice ids, the turns per voice, and the record speeches per voice (from the matches). Note them in the README.
  - Check AssemblyAI's speaker-count options (`speakers_expected`, or a min/max range) in its docs and on one real call **[unverified]**.
  - If a count from the record improves the split, add the option to `transcribe/assemblyai.ts` behind the record link as a follow-up task, and note it. Don't change transcription in this task.
- [ ] **Step 3: Label 30 turns.** Spread them over the session: the person, from the record text and the video, or `null`. Save them as `speakers` in the new golden file, with `labelledBy` "drafted by Claude; owner review pending".
- [ ] **Step 4: Tune `RECORD_CONFIRM` and `RECORD_PROPOSE`** with the eval's "AI only" block, aiming for wrong ≤ 1% of labelled speaking time with as much correct as possible. Re-run `handleNames` for the session after each change (re-link the record).
- [ ] **Step 5: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test align` (the thresholds' tests still pass, adjusted only if a boundary value moved), then the eval on both golden files.
- [ ] **Step 6: Commit** `chore(eval): Senado sample and record thresholds`. Ask the owner to review the labels.

## Slice 5: Câmara record

### Task 17: Câmara, if a per-session speech list exists

**Files:**
- Create (if supported): `apps/worker/src/records/camara.ts` and fixtures
- Modify: `apps/worker/src/jobs.ts` (`handleNames` branches on `chamber`), `apps/web/app/api/sessions/[id]/record/route.ts` (drops the 422 if supported)
- Modify (if not supported): `README.md` and the spec's §7.4, noting "Câmara record naming moves to Plan 4", with what was tried

- [ ] **Step 1: Look for the endpoint.** With real calls to `https://dadosabertos.camara.leg.br/api/v2/`, find one that lists a plenary event's speeches or speakers with text (for example `/eventos/{id}` and its sub-resources, or the stenographic notes). Record what each returns, or its status.
- [ ] **Step 2 (supported):**
  - Write the failing tests `fetchCamaraSpeeches parses the event's speeches in order` and `handleNames uses the Câmara client for a Câmara ref`, against the recorded fixtures.
  - Implement `fetchCamaraSpeeches(eventId: string, f?: typeof fetch): Promise<RecordSpeech[]>` and `fetchDeputado(id)`, reusing `alignTurns`.
  - Run the worker tests and expect PASS.
- [ ] **Step 2 (not supported):** keep the 422 and write the note. No code.
- [ ] **Step 3: Commit** `feat(worker): Câmara record names`, or `docs: Câmara record naming deferred to Plan 4`.

## Slice 6: Ask, reports and results

### Task 18: Ask knows names, Report a problem on names, README

**Files:**
- Modify: `apps/worker/src/agents/ask.ts`:
  - "Known participants" is built from `listAttributions` + `getPersons`, with "(confirmed)" or "(proposed)".
  - New tool `list_speeches`.
- Modify: `packages/core/src/personalTypes.ts` (`ProblemTargetKind` adds `"attribution"`), `apps/web/app/api/reports/route.ts` (the enum), `components/Names/NamePopover.tsx` (a "Report a problem" item, using the existing `ReportProblem` component)
- Modify: `README.md` (Plan 3 in the feature list; the attribution results from Tasks 8, 12 and 16), plus the memory notes
- Test: `apps/worker/src/agents/ask.test.ts`, `apps/web/app/api/misc.test.ts`

**Interfaces:**
- Consumes: Task 1 `turnsOf`, `personAt`, `normaliseName`; Task 2 repo.
- Produces: the Ask tool `list_speeches`, with schema `z.object({ person: z.string() })`.
  - It resolves the person by `normaliseName` among the session's persons (closest match, or "No one by that name speaks in this session.").
  - It returns up to 30 lines: `[hh:mm:ss–hh:mm:ss] <length> · <topic title>`, through `evidence()`.

- [ ] **Step 1: Write the failing tests:**
  - `ask: known participants come from attributions with their status`;
  - `ask: list_speeches lists a person's turns with topics`;
  - `ask: list_speeches answers plainly for an unknown name`;
  - `reports: accepts targetKind attribution`.
- [ ] **Step 2: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test ask` and `pnpm --filter @digestor/web test misc`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `pnpm test:worker` and `pnpm typecheck`. Then do the full journalist pass from the digestor-run skill on the debate at 1280 and 390 px: Who's who → Preview → Full briefing (focus on a person, Find more) → Prepare (blocked until confirmed) → Export. Expected: all green and `errors.txt` empty.
- [ ] **Step 5: Commit** `feat: Ask and reports know speaker names; README results`.
