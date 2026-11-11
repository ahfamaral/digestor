# Câmara monitor UX round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the merged monitor preview into a deputy-first tool: a deputy combobox and a filtered topic search on
`/monitor`, a deputy workspace (party timeline, positions, profile, authored bills, presence record, by/mentioning
search), and a roll-call page grouped by party at the time of the vote.

**Architecture:** New official data (history, profile, orientations, bills and authors, sessions and presence) lands in
new tables and columns (migration 0023), loaded by the existing `refreshMonitor` from Câmara API calls (4 in flight) and
yearly bulk files (one at a time). Queries live in `packages/core/src/db/monitor.ts` (search) and a new
`monitorRecord.ts` (everything else). Pages stay server components; only the deputy combobox and the year dropdown are
client components (Base UI). All URL state is parsed in one place (`lib/monitor/params.ts`).

**Tech Stack:** Next.js 16 (App Router, Cache Components), Drizzle + Postgres FTS (`pt_unaccent`), pg-boss, zod,
csv-parse, `@base-ui/react` 1.9, vitest, Playwright (via the `digestor-run` skill).

**Spec:** `docs/superpowers/specs/2026-11-11-monitor-search-filters-design.md` (extends
`docs/superpowers/specs/2026-11-11-camara-monitor-preview-design.md`).

## Global Constraints

- Official records only, shown as published; no AI text about a person; speeches and votes never shown as if one explains the other; no rankings or scores.
- Presence: "Present at N of M plenary deliberative sessions while in office (2026)"; **no percentage, no comparison with other deputies, no ranking, no colour**; "No presence recorded", never "absent"; the note "The open data doesn't say why: justified absences, leave and missions look the same."
- Code never fetches `www.camara.leg.br` pages. API calls at most 4 in flight (`mapLimit`, `CONCURRENCY = 4`); bulk files one at a time with `fetchYearCsv`.
- Copy only through `tm()` in `apps/web/messages/monitor.ts`, English and Portuguese (Brazil), every key in both (the parity test exists). Each task adds the keys it uses. No "→" glyph in labels.
- `digestor-ui` rules: tokens only (no new hex), brand button for the primary action, `text-muted-foreground` for muted text, visible focus, 390 px without horizontal scroll.
- Base UI (`@base-ui/react` 1.9: `combobox`, `select` via `components/ui/select.tsx`); no new library. Only `DeputyCombobox` and `YearSelect` are `"use client"`; `@digestor/core/server` never reaches them.
- Year: only 2026. `year` in the URL; any other value is 2026.
- Pages read the DB inside `<Suspense>` after `await connection()`; `params`/`searchParams` are Promises.
- Core relative imports end in `.ts`; the worker's in `.js`.
- Work on branch `feat/monitor-ux-round` (created from `main` at Task 1); one commit per task; no push.
- Tests: core and web on the host (`pnpm --filter … test`), worker in the container. Never run the host and worker suites at the same time. Never touch the owner's 4 sessions.
- Cut-off Thu 12 Nov night. Drop in this order if late: fronts (Task 7), timeline + positions rendering (Task 7; the data stays), presence rendering (Task 7), the guidance list (Task 8).

## Review Focus

1. A deputy with no history rows (API answered empty) → no party-on-the-day (speech shows today's party, no "now …"), no presence line but "Presence not available for this deputy.", no crash. Tests: Task 2 (`getPresence` → null, `partyTimeline([])`), Task 7 (render).
2. Mention search with a one-word name ("Paulão"), a hyphen or an apostrophe ("Dr. Zacharias Calil", "Coronel Chrisóstomo", "D'Ávila") → matches or not, never a Postgres error. Test: Task 2.
3. Tampered URLs (`from` after `to`, dates outside 2026, `party=';--`, `p=-1`, repeated keys, `year=1999`, `rel=x`) → ignored or normalised, never a 500. Tests: Task 5.
4. The suggestions route with 1 character, 300 characters, control characters, or no session cookie → `{ rows: [], more: false }` / 401. Tests: Task 5.
5. Two speeches of one deputy with the same `startsAt` and the same text in one window → both stored with distinct keys; the insert never fails on the unique key. Test: Task 1.

---

### Task 1: Data model (migration 0023) and write functions

**Files:**
- Modify: `packages/core/src/db/schema.ts` (after `parlVotes`)
- Create: `packages/core/drizzle/0023_monitor_workspace.sql` (generated: `pnpm --filter @digestor/core db:generate --name monitor_workspace`)
- Modify: `packages/core/src/db/monitor.ts` (`replaceSpeechWindow`, `replaceVotes`)
- Create: `packages/core/src/db/monitorRecord.ts`
- Modify: `packages/core/src/server.ts` (export `monitorRecord.ts`)
- Test: `packages/core/src/db/monitorRecord.test.ts`, `packages/core/src/db/monitor.test.ts`

**Interfaces:**
- Produces (schema):
  - `parlMembers` + `profession text`, `externalMandates jsonb $type<ExternalMandate[]>`, `fronts jsonb $type<string[]>`, `positions jsonb $type<Position[]>`, `profileRefreshedAt timestamptz` (all nullable).
  - `parlMemberHistory` (`parl_member_history`): `id serial pk`, `memberId` fk cascade, `at timestamp(string) not null`, `party`, `uf`, `status` (nullable text), `description text not null default ''`; index `(member_id, at)`.
  - `parlSpeeches` + `speechKey text` (unique index `parl_speeches_key`), `party text`, `uf text` (party and state on the day).
  - `parlVotes` + `party text`, `uf text` (at the vote).
  - `parlOrientations` (`parl_orientations`): `rollCallId` fk cascade, `bloc text not null`, `orientation text not null default ''`; pk `(roll_call_id, bloc)`.
  - `parlBills` (`parl_bills`): `id integer pk` (proposição id), `house`, `type`, `number integer`, `year integer`, `summary text default ''`, `presentedAt timestamp(string) not null`; index `presented_at`.
  - `parlBillAuthors` (`parl_bill_authors`): `billId` fk cascade, `memberId` fk cascade, `firstAuthor boolean not null`; pk `(bill_id, member_id)`; index `member_id`.
  - `parlSessions` (`parl_sessions`): `id integer pk` (event id), `house`, `startsAt timestamp(string) not null`, `description text not null`, `status text not null`. Only "Sessão Deliberativa" events are stored.
  - `parlPresence` (`parl_presence`): `sessionId` fk cascade, `memberId` fk cascade; pk.
- Produces (types, `monitorRecord.ts`): `ExternalMandate = { office: string; place: string; uf: string | null; from: number; to: number | null; party: string | null }`, `Position = { body: string; bodyName: string; title: string; from: string; to: string | null }` (days), `HistoryInput = { at: string; party: string | null; uf: string | null; status: string | null; description: string }`, `ProfileInput = { profession: string | null; externalMandates: ExternalMandate[]; fronts: string[]; positions: Position[] }`, `BillInput = { id: number; type: string; number: number; year: number; summary: string; presentedAt: string }`, `SessionInput = { id: number; startsAt: string; description: string; status: string }`.
- Produces (functions, `monitorRecord.ts`):
  - `replaceHistory(db, memberId: number, rows: HistoryInput[]): Promise<void>` (one transaction).
  - `setProfile(db, memberId: number, p: ProfileInput): Promise<void>` (sets `profileRefreshedAt = now()`).
  - `membersNeedingProfile(db, house: House, all: boolean): Promise<{ id: number; externalId: number }[]>` (`all=false`: only `profileRefreshedAt is null`).
  - `fillSpeechParties(db): Promise<number>`: one `UPDATE … FROM LATERAL`: each speech's `party`/`uf` = the member's last history row with `at <= starts_at`; speeches of members without history keep null. Returns rows updated.
  - `upsertBills(db, rows: BillInput[]): Promise<void>`; `replaceBillAuthors(db, billIds: number[], rows: { billId: number; memberId: number; firstAuthor: boolean }[]): Promise<void>` (delete the authors of `billIds`, insert `rows`).
  - `replaceOrientations(db, rollCallId: string, rows: { bloc: string; orientation: string }[]): Promise<void>`.
  - `upsertSessions(db, rows: SessionInput[]): Promise<void>`; `replacePresence(db, sessionIds: number[], rows: { sessionId: number; memberId: number }[]): Promise<void>`.
- Changes (`monitor.ts`): `replaceSpeechWindow` sets `speechKey` on every row it inserts: `${externalId}:${startsAt}:${sha1(normName(text || summary)).slice(0, 10)}`, the n-th duplicate inside one call gets `:${n}` appended (n ≥ 2); `externalId` is read once from `parl_members` inside the transaction (signature unchanged). `replaceVotes(db, rollCallId, rows: { memberId: number; vote: string; party?: string | null; uf?: string | null }[])`.

- [ ] **Step 1: Branch.** `git switch -c feat/monitor-ux-round`; add the spec file and this plan in the Task 1 commit.
- [ ] **Step 2: Write the failing tests**

```ts
// monitor.test.ts
it("a speech keeps its key across a window replace; duplicates get distinct keys", async () => {
  const { a } = await twoMembers();
  await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [speech("2026-03-17T18:00", "O feminicídio no RS")]);
  const k1 = (await db.select().from(parlSpeeches)).map((r) => r.speechKey);
  expect(k1[0]).toMatch(/^204407:2026-03-17T18:00:[0-9a-f]{10}$/);
  await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [
    speech("2026-03-17T18:00", "O feminicídio no RS"), speech("2026-04-01T10:00", "outro"),
  ]);
  const k2 = (await db.select().from(parlSpeeches)).map((r) => r.speechKey);
  expect(k2).toContain(k1[0]);
  await replaceSpeechWindow(db, a, "2026-02-01", "2026-11-11", [speech("2026-05-01T10:00", "igual"), speech("2026-05-01T10:00", "igual")]);
  const k3 = (await db.select().from(parlSpeeches)).map((r) => r.speechKey!).sort();
  expect(k3[1]).toBe(`${k3[0]}:2`);
});
it("replaceVotes stores the party at the vote", async () => { /* replaceVotes with party "UNIÃO", uf "AL"; select → party "UNIÃO" */ });

// monitorRecord.test.ts
it("fillSpeechParties takes the party on the day", async () => {
  // member 220576 history: 2023-02-01T12:05 UNIÃO/AL "Exercício"; 2026-04-29T22:10 PL/AL "Exercício"
  // speeches 2026-04-29T18:00 and 2026-05-01T10:00; a second member with no history and one speech
  // expect parties ["UNIÃO", "PL", null]; returns 2
});
it("membersNeedingProfile: all, or only those never refreshed", async () => { /* setProfile on one of two → all:2, missing:1 */ });
it("replaceHistory replaces the member's rows", async () => { /* two calls → only the second call's rows remain */ });
```

- [ ] **Step 3: Run:** `pnpm --filter @digestor/core test monitor` — Expected: FAIL (no `speechKey` column / `monitorRecord.ts` missing).
- [ ] **Step 4: Implement** the schema, generate the migration (check the SQL: only `ALTER TABLE … ADD COLUMN`, `CREATE TABLE`, indexes; no drops), `pnpm db:migrate`, then the functions above. `sha1` from `node:crypto` (server file).
- [ ] **Step 5: Run:** `pnpm --filter @digestor/core test` — Expected: PASS (all core tests).
- [ ] **Step 6: Commit** `feat(monitor): history, profile, bills, presence and guidance tables; stable speech key`.

### Task 2: Queries: filtered search, mentions, timeline, presence, bills, roll-call detail

**Files:**
- Modify: `packages/core/src/db/monitor.ts` (`searchSpeeches`, `listMemberSpeeches`, `searchRollCalls`; add `speechFacets`)
- Modify: `packages/core/src/db/monitorRecord.ts` (reads)
- Create: `packages/core/src/monitorTimeline.ts` (pure, client-safe; export from `index.ts`)
- Test: `packages/core/src/db/monitor.test.ts`, `packages/core/src/db/monitorRecord.test.ts`, `packages/core/src/monitorTimeline.test.ts`

**Interfaces:**
- Consumes: Task 1 tables and writers.
- Produces (`monitor.ts`):
  - `SpeechFilters = { from?: string; to?: string; party?: string; uf?: string; phase?: string; inOffice?: boolean }` (days inclusive; `party`/`uf` on the day = `parl_speeches.party/uf`).
  - `searchSpeeches(db, a: { terms: string[]; memberId?: number; mentionOf?: { memberId: number; name: string }; filters?: SpeechFilters; sort?: "best" | "new"; limit?: number; offset?: number }): Promise<{ total: number; rows: SpeechHit[] }>`. `mentionOf`: speeches matching `phraseto_tsquery('pt_unaccent', name)` by other members (`member_id <> mentionOf.memberId`); `terms` may then be empty; with terms the match is `name && (t1 || t2 …)`; the headline query is `name || terms`, so the name is highlighted. `sort: "new"` orders by `starts_at desc, id desc`; default best (rank, then newest).
  - `SpeechHit` gains `partyThen: string | null; ufThen: string | null`.
  - `listMemberSpeeches(db, memberId, a: { limit?; offset?; from?: string; to?: string; phase?: string })`.
  - `searchRollCalls(db, a: { terms: string[]; from?: string; to?: string; sort?: "best" | "new"; limit?: number; offset?: number }): Promise<{ total: number; rows: RollCallHit[] }>` (**return type changes**; still roll calls only).
  - `speechFacets(db): Promise<{ parties: string[]; ufs: string[]; phases: string[] }>` (distinct non-null values on speeches, sorted with `localeCompare(…, "pt-BR")`).
- Produces (`monitorTimeline.ts`):
  - `HistoryRow = { at: string; party: string | null; uf: string | null; status: string | null; description: string }`.
  - `TimelineBand = { party: string | null; uf: string | null; from: string; to: string | null; inOffice: boolean; description: string }` (days; `to` null = today).
  - `partyTimeline(rows: HistoryRow[], since = "2023-02-01"): TimelineBand[]`: rows by `at`; in office ⇔ `status === "Exercício"`; a new band starts when party or in-office changes; an out-of-office band carries its row's `description`; bands before `since` are clipped to it.
  - `inOfficePeriods(bands: TimelineBand[]): { from: string; to: string | null }[]`.
- Produces (`monitorRecord.ts`):
  - `getHistory(db, memberId): Promise<HistoryRow[]>`; `getProfile(db, memberId): Promise<ProfileInput & { refreshedAt: string | null }>`.
  - `getPresence(db, memberId: number, year: number): Promise<{ sessions: number; present: number; missing: { id: number; startsAt: string; description: string }[] } | null>`: sessions with `status = 'Encerrada'` in `year`, counted only inside `inOfficePeriods(partyTimeline(history))`; `null` when the member has no history.
  - `listMemberBills(db, memberId, a: { type?: string; limit?: number; offset?: number }): Promise<{ total: number; byType: { type: string; n: number }[]; rows: { id: number; type: string; number: number; year: number; summary: string; presentedAt: string; firstAuthor: boolean }[] }>` (newest first; `byType` ignores the type filter, most first then name).
  - `RollCallDetail = { id; date; description; yes; no; other; billId: number | null; billLabel: string | null; billSummary: string; parties: { party: string | null; counts: { vote: string; n: number }[]; deputies: { externalId: number; name: string; uf: string | null; vote: string }[] }[]; orientations: { bloc: string; orientation: string }[] }`.
  - `getRollCall(db, id: string): Promise<RollCallDetail | null>`: party = the vote row's `party`, else the member's current party; parties by deputy count desc then name; deputies by name (`pt-BR`); `counts` in the order Sim, Não, Abstenção, Obstrução, Artigo 17, then any other label as published; orientations as stored, ordered by bloc.

- [ ] **Step 1: Write the failing tests** (names and the assertions that matter):
  - `searchSpeeches filters by dates, party on the day, state, phase and in office` — the 220576 setup from Task 1 plus `fillSpeechParties`: `party: "UNIÃO"` finds the 29 Apr speech only, `party: "PL"` the 1 May one; `from/to` narrows; `phase` exact; `inOffice: true` drops a member with `in_office = false`; hits carry `partyThen`.
  - `searchSpeeches sorts by best match or newest` — two hits, the older one ranks higher: default order `[older, newer]`, `sort: "new"` → `[newer, older]`.
  - `mentions: others' speeches naming the deputy, topic optional, name highlighted` — B's speech "a deputada Fernanda Melchionna defendeu…" and A's own speech naming herself: `mentionOf: {memberId: a, name: "Fernanda Melchionna"}, terms: []` → only B's, snippet contains `\u0001Fernanda`; with `terms: ["orçamento"]` → 0.
  - `mention names never break the query` — `["Paulão", "Dr. Zacharias Calil", "D'Ávila", "Coronel Chrisóstomo-Silva"]` each resolve without throwing.
  - `searchRollCalls pages, filters by date and sorts` — 3 matching roll calls: `{limit: 2}` → `total 3, rows 2`; `from: "2026-05-01"` → 1; `sort: "new"` newest first.
  - `speechFacets lists values alphabetically` — parties `["PL", "PSOL", "UNIÃO"]`.
  - `partyTimeline` (pure): 220576 rows → `[{party: "UNIÃO", from: "2023-02-01", to: "2026-04-29", inOffice: true}, {party: "PL", from: "2026-04-29", to: null, inOffice: true}]`; a leave row (`status: "Afastado"`, description "Afastamento - Investidura no cargo de Ministro") then a return → three bands, the middle `inOffice: false` with that description; `[]` → `[]`.
  - `getPresence counts closed deliberative sessions while in office` — 4 sessions (3 `Encerrada`, 1 `Cancelada`), member in office from the 2nd session's day, present at 1 → `{ sessions: 2, present: 1, missing: [the other one] }`; no history → `null`.
  - `listMemberBills counts by type and filters` — 3 bills (PL, PL, RCP) → `byType [{PL,2},{RCP,1}]`, `type: "RCP"` → `total 1`, `firstAuthor` as stored.
  - `getRollCall groups by party at the vote` — deputy now PL voted under UNIÃO → in the UNIÃO block; counts order; an empty orientation is returned as `""`; unknown id → `null`.
- [ ] **Step 2: Run:** `pnpm --filter @digestor/core test` — Expected: FAIL on the new tests only.
- [ ] **Step 3: Implement.** Filters are `sql` fragments added to the existing `hits` subquery; the mention phrase goes through `phraseto_tsquery` (never `websearch_to_tsquery`, whose syntax a name could trigger) and the `numnode` guard stays.
- [ ] **Step 4: Run:** `pnpm --filter @digestor/core test && pnpm --filter @digestor/core typecheck` — Expected: PASS. (Web will not typecheck until Task 5 updates `runSearch`; that is expected.)
- [ ] **Step 5: Commit** `feat(monitor): filtered and mention search, party timeline, presence, bills and roll-call queries`.

### Task 3: Câmara fetchers and bulk parsers

**Files:**
- Modify: `apps/worker/src/monitor/camara.ts`
- Create: `apps/worker/src/monitor/bulk.ts` (new bulk parsers; `parseCsv` moves here and `rollCalls.ts` imports it)
- Modify: `apps/worker/src/monitor/fakeCamaraMonitor.ts`, `apps/worker/test/fixtures/camara-monitor/README.md`
- Create fixtures (recorded 2026-11-11/12 with `curl`, excerpts trimmed by hand): `historico-220576.recorded.json`, `historico-<leave>.recorded.json` (a deputy from `/deputados?dataInicio=2026-02-01` whose history has a `situacao` other than "Exercício" after 2023; note who in the README), `profissoes-204407`, `mandatosExternos-204407`, `frentes-204407`, `orgaos-204407` (page 1) `.recorded.json`; excerpts `votacoesOrientacoes-2026` (rows of 2449741-72 and 2462009-57), `eventos-2026` (3 "Sessão Deliberativa", one not "Encerrada", plus one "Reunião Deliberativa"), `eventosPresencaDeputados-2026` (those events, 204407 at 2 of them), `proposicoes-2026` (2600034 RCP 1/2026, one more 2026 bill, one presented in January), `proposicoesAutores-2026` (a committee author row, a first author, a co-author) `.excerpt.csv`
- Test: `apps/worker/src/monitor/camara.test.ts`, `apps/worker/src/monitor/bulk.test.ts`

**Interfaces:**
- Consumes: Task 1 types (`HistoryInput`, `ProfileInput`, `ExternalMandate`, `Position`, `BillInput`, `SessionInput`).
- Produces (`camara.ts`): `LEGISLATURE_FROM = "2023-02-01"`; `fetchHistory(f, externalId): Promise<HistoryInput[]>` (`at = dataHora.slice(0, 16)`, `description = descricaoStatus ?? ""`; 404 → `[]`); `fetchProfile(f, externalId): Promise<ProfileInput>` (4 calls: `profissoes` first `titulo` or null; `mandatosExternos` through `mergeMandates`; `frentes` titles with `idLegislatura === 57`; `orgaos?dataInicio=2023-02-01&itens=100` all pages → `Position` with `bodyName = nomePublicacao ?? nomeOrgao`); `mergeMandates(rows: ExternalMandate[]): ExternalMandate[]` (same office, place, uf and party, next `from` ≤ previous `to` + 1 → one span); `YearCsv` gains `"votacoesOrientacoes" | "eventos" | "eventosPresencaDeputados" | "proposicoes" | "proposicoesAutores"`.
- Produces (`bulk.ts`): `parseCsv(text: string, keep?: string[]): CsvRow[]` (with `keep`, other columns are skipped at parse time: `proposicoes-2026.csv` is 44 MB); `toOrientations(rows, rollCallIds: Set<string>): Map<string, { bloc: string; orientation: string }[]>` (`siglaBancada`, `orientacao` trimmed); `toSessions(rows): SessionInput[]` (`descricaoTipo === "Sessão Deliberativa"`, all statuses); `toPresence(rows, sessionIds: Set<number>): { sessionId: number; externalId: number }[]`; `toBills(rows, from = MONITOR_FROM): BillInput[]` (`dataApresentacao >= from`); `toBillAuthors(rows, billIds: Set<number>): { billId: number; externalId: number; firstAuthor: boolean }[]` (rows with a numeric `idDeputadoAutor` only; `firstAuthor = ordemAssinatura === "1"`).

- [ ] **Step 1: Record the fixtures** and update the README (what, when, which deputy has the leave).
- [ ] **Step 2: Write the failing tests:** `fetchHistory maps 220576` (3 rows, last `{party: "PL", at: "2026-04-29T22:10", description: "Alteração de partido"}`); `fetchProfile maps 204407` (`profession: "Bibliotecária"`, `externalMandates: [{office: "Vereador(a)", place: "Porto Alegre", uf: "RS", from: 2009, to: 2018, party: "PSOL"}]`, fronts non-empty, a position with `body: "CMULHER"`); `mergeMandates keeps a gap and a party change apart`; one test per bulk parser on its excerpt (including: a "Reunião Deliberativa" is not a session; a January bill is dropped; a committee author is skipped; `keep` leaves only the named columns).
- [ ] **Step 3: Run:** `docker compose run --rm worker pnpm --filter @digestor/worker test monitor` — Expected: FAIL on the new tests.
- [ ] **Step 4: Implement** (zod schemas `.passthrough()` and lenient like the existing ones).
- [ ] **Step 5: Run** the same command — Expected: PASS.
- [ ] **Step 6: Commit** `feat(monitor): Câmara history, profile, guidance, sessions, presence and authored bills clients`.

### Task 4: Refresh wiring

**Files:**
- Modify: `apps/worker/src/monitor/refresh.ts`, `apps/worker/scripts/monitor-backfill.ts`, `apps/worker/src/main.ts` (pass `profiles` from `nightlyWindow`)
- Test: `apps/worker/src/monitor/refresh.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `refreshMonitor(deps, a: { speechesFrom: string; to: string; year: number; profiles: "all" | "missing" })`; `RefreshCounts` gains `history: { ok: number; failed: number }`, `profiles: { ok: number; failed: number }`, `orientations: number`, `sessions: number`, `presence: number`, `authoredBills: number`; `nightlyWindow(now)` returns `profiles: now.getUTCDay() === 1 ? "all" : "missing"`; the backfill passes `"all"`.
- Order: members → in-office → history for every deputy (4 in flight; failures counted; throw only when more than half failed, like speeches) → speeches → `fillSpeechParties` → profiles (`membersNeedingProfile`; failures counted, never throw) → bulk files one at a time: votacoes, votacoesObjetos, votacoesVotos (as today; votes now carry party/uf), then votacoesOrientacoes, eventos, eventosPresencaDeputados, proposicoes (`keep` = id, siglaTipo, numero, ano, ementa, dataApresentacao), proposicoesAutores. A final 4xx on one of the five new files skips that part only (warn); the first three keep today's behaviour. Presence and authors of unknown deputies are skipped (not inserted as members).

- [ ] **Step 1: Write the failing tests:** `a full run stores history, party on the day, profile, guidance, presence and authored bills` (on the fixtures: 204407's speeches have `party = "PSOL"`; 2449741-72 has orientations; 204407 has 2 presence rows; RCP 1/2026 listed for 204407); `profiles: "missing" refetches only members never refreshed` (count `/profissoes` calls: second run with `"missing"` → 0, with `"all"` → all members); `a missing guidance file still stores roll calls and votes` (override the orientations URL with a 404); `one deputy's history failing is counted and the run goes on`; `nightlyWindow is "all" on Mondays` (`2026-11-16` → `"all"`, `2026-11-17` → `"missing"`).
- [ ] **Step 2: Run:** `docker compose run --rm worker pnpm --filter @digestor/worker test monitor` — Expected: FAIL.
- [ ] **Step 3: Implement.** Extend `fakeCamaraMonitorFetch` for the new paths (unknown deputies' history/profile → `{ dados: [] }`; a 404 override must be possible: allow an override value `{ status: 404 }` with a numeric status to answer that status).
- [ ] **Step 4: Run:** `pnpm test:worker` — Expected: PASS (whole worker suite).
- [ ] **Step 5: Rerun the dev backfill** (`docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-backfill.ts`); record its counts and duration in the ledger. Expected: history ≈ 568 ok, profiles ≈ 568, presence rows ≈ 65k filtered to sessions, no throw. Check 204407: `select party, count(*) from parl_speeches where member_id = … group by 1` → PSOL only.
- [ ] **Step 6: Commit** `feat(monitor): refresh history, profiles (weekly), guidance, presence and authored bills`.

### Task 5: URL parameters, landing search and the suggestions route

**Files:**
- Create: `apps/web/lib/monitor/params.ts`
- Modify: `apps/web/lib/monitor/search.ts` (`runSearch`; `backPath` removed in favour of `landingHref`/`deputyHref`)
- Create: `apps/web/app/api/monitor/deputies/route.ts`
- Test: `apps/web/lib/monitor/params.test.ts`, `apps/web/app/api/monitor/deputies/route.test.ts`, `apps/web/middleware.test.ts` (one case)

**Interfaces:**
- Consumes: Task 2 (`searchSpeeches`, `searchRollCalls`, `searchMembers`).
- Produces (`params.ts`):
  - `MONITOR_YEARS = [2026] as const`; `yearParam(v): number` (always a member of `MONITOR_YEARS`, default 2026).
  - `LandingParams = { q: string; show: { speeches: boolean; rollCalls: boolean }; from: string | null; to: string | null; party: string | null; uf: string | null; phase: string | null; inOffice: boolean; sort: "best" | "new"; year: number; p: number; rp: number }`; `parseLanding(sp: Record<string, string | string[] | undefined>): LandingParams`.
  - `DeputyParams = { q: string; rel: "by" | "mentions"; from: string | null; to: string | null; phase: string | null; sort: "best" | "new"; year: number; p: number; btype: string | null; bp: number }`; `parseDeputy(sp): DeputyParams`.
  - Rules: first value of a repeated key, except `show` (all values; `speeches`/`rollcalls`; none valid → both); dates `YYYY-MM-DD`, a real date inside `year`, else null; `from > to` → swapped; `party` `/^[\p{L}\d ._-]{1,30}$/u`; `uf` `/^[A-Z]{2}$/`; `phase` and `btype` cleaned with `cleanQuery`, ≤ 120 / ≤ 10 chars; `inOffice` only `"1"`; `sort` only `"new"`; `rel` only `"mentions"`; pages via `pageParam`.
  - `landingHref(p: Partial<LandingParams>): string` and `deputyHref(externalId: number, p?: Partial<DeputyParams>): string`: only non-default values, fixed key order (`q, show, from, to, party, uf, phase, inOffice, sort, year, p, rp` / `q, rel, from, to, phase, sort, year, p, btype, bp`). `rollCallHref(id: string) = "/monitor/votacoes/" + id`; `isRollCallId(id) = /^\d{1,9}-\d{1,4}$/`.
- Produces (`search.ts`): `LandingResult = Searched & { speeches: { total: number; rows: SpeechHit[] } | null; rollCalls: { total: number; rows: RollCallHit[] } | null }`; `runSearch(db, p: LandingParams, translate?: Translate): Promise<LandingResult>` (a group not shown is `null`; speeches paged by `p`, roll calls by `rp`, both `SEARCH_PAGE`).
- Produces (route): `GET /api/monitor/deputies?q=` → `{ rows: { externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null; inOffice: boolean }[]; more: boolean }`; `normName(cleanQuery(q)).length < 2` → empty; `searchMembers(db, q, 9)` → first 8 + `more`. Behind the existing middleware gate (401 JSON).

- [ ] **Step 1: Write the failing tests:** `parseLanding ignores invalid values` (the Review Focus 3 list, one assertion each; `year=1999` → 2026); `from after to is swapped`; `show with no valid value means both`; `landingHref round-trips` (`parseLanding(Object.fromEntries(new URLSearchParams(landingHref(x).split("?")[1])))` equals `x` for a full `x`, with `show` given as an array); `deputyHref omits defaults` (`deputyHref(204407)` → `/monitor/deputados/204407`); route: `fewer than 2 letters → empty`, `9 matches → 8 rows and more`, `control characters are stripped`, `row shape`; middleware: `/api/monitor/deputies` without a cookie → 401.
- [ ] **Step 2: Run:** `pnpm --filter @digestor/web test monitor middleware` — Expected: FAIL.
- [ ] **Step 3: Implement.** Update existing callers of `backPath`/`runSearch` just enough to compile (`SearchView` keeps working until Task 6 replaces it).
- [ ] **Step 4: Run:** `pnpm --filter @digestor/web test && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(monitor): URL parameters, filtered landing search, deputy suggestions route`.

### Task 6: Deputy combobox, year dropdown, two-door landing

**Files:**
- Create: `apps/web/components/Monitor/DeputyCombobox.tsx` (`"use client"`), `apps/web/components/Monitor/YearSelect.tsx` (`"use client"`), `apps/web/components/Monitor/LandingView.tsx`, `apps/web/components/Monitor/TopicFilters.tsx`, `apps/web/components/Monitor/SortSwitch.tsx`, `apps/web/lib/monitor/suggest.ts`
- Modify: `apps/web/app/monitor/page.tsx`, `Pager.tsx`, `SpeechItem.tsx`, `RollCallItem.tsx`, `apps/web/messages/monitor.ts`
- Delete: `SearchView.tsx` (replaced by `LandingView`)
- Test: `apps/web/components/Monitor/monitor.test.tsx`, `apps/web/lib/monitor/suggest.test.ts`

**Interfaces:**
- Consumes: Task 5 (`parseLanding`, `landingHref`, `deputyHref`, `rollCallHref`, `runSearch`, the route), Task 2 (`speechFacets`, `SpeechHit.partyThen`).
- Produces: `DeputyCombobox({ locale, size: "lg" | "sm", label: string })`: Base UI `Combobox` (API: `apps/web/node_modules/@base-ui/react/combobox/*.d.ts`); concept and panel look from an earlier location-search component of the owner's (`SuggestionsPanel`), restyled with the product tokens. Fetch from 2 characters, debounced 200 ms, the previous request aborted; panel header "SUGGESTIONS" + count ("3 deputies"); a row = photo (32 px), name, "PSOL · RS", "Not in office now" badge; ↑/↓, Enter or click → `router.push(deputyHref(id))`; Esc clears the text, a second Esc closes; states: searching, "No deputy matches", error line + "Try again", "8 shown, keep typing".
- `panelStatus(s: { q: string; loading: boolean; error: boolean; rows: number; more: boolean }): "idle" | "searching" | "none" | "error" | "list" | "listMore"` in `suggest.ts` (pure; `idle` under 2 letters).
- `YearSelect({ locale, year })`: `components/ui/select.tsx`, one item "2026", the muted line "Only 2026 for now" inside the popup; changing it navigates with `year` set (no-op today).
- `Pager({ locale, page, size, total, href: (page: number) => string })`; copy keys `paging.previous` / `paging.next` ("Previous" / "Next", "Anterior" / "Próxima"); `paging.newer/older` removed.
- `SpeechItem` shows `partyThen-ufThen` and, when `member.party` differs, "now {party}"; `RollCallItem` title links to `rollCallHref(id)` (the official bill link stays as a separate link).
- `LandingView`: header (title, `YearSelect`, `LanguageSwitch` with `back = landingHref(params)`, data note); door 1 card ("Find a deputy", combobox lg); door 2 card ("Search a topic across the Câmara": GET form to `/monitor`, `q`, Search, `TopicFilters`: Show ☑ Speeches ☑ Roll calls, From / To (`type="date"`, min/max inside the year), Party (on the day), State (on the day), Session phase (native `<select>` styled with tokens, options from `speechFacets`, first option "Any"), Only deputies in office, "Clear filters" link to `landingHref({ q })`); `SearchedFor`; `SortSwitch` (two links, `aria-current` on the active one; hrefs keep every filter, reset `p`/`rp`); Speeches and Roll calls sections each with a count and their own `Pager` (`p` / `rp`). No "Deputies" group. Ruling recorded: filter dropdowns are native selects so the GET form works without JavaScript.

- [ ] **Step 1: Write the failing tests:** `panelStatus` (each state); `landing without a query shows both doors and no results`; `a speech shows the party on the day and "now PL" when it changed`; `a roll call opens the roll-call page` (`href="/monitor/votacoes/2449741-72"`); `Pager says Previous / Next and keeps the filters` (`href` contains `party=PSOL&p=1`); `only the ticked group is shown` (`show: { speeches: true, rollCalls: false }` → no "Roll calls" heading).
- [ ] **Step 2: Run:** `pnpm --filter @digestor/web test monitor` — Expected: FAIL.
- [ ] **Step 3: Implement**, with the copy in both languages.
- [ ] **Step 4: Run:** `pnpm --filter @digestor/web test && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Look at it** (`digestor-run`): `/monitor` at 1280 and 390 px; type "melch" (panel, keyboard ↓ Enter lands on 204407), Esc twice; a filtered topic search; `errors.txt` empty. Read the PNGs.
- [ ] **Step 6: Commit** `feat(monitor): two-door landing with deputy combobox, filters, sort and year`.

### Task 7: The deputy workspace

**Files:**
- Modify: `apps/web/app/monitor/deputados/[id]/page.tsx`, `apps/web/components/Monitor/DeputyView.tsx`, `VoteRow.tsx`, `apps/web/messages/monitor.ts`
- Create: `apps/web/components/Monitor/PartyTimeline.tsx`, `Positions.tsx`, `DeputySearch.tsx`, `AuthoredBills.tsx`, `Presence.tsx`, `Fronts.tsx`, `ProfileLine.tsx`
- Test: `apps/web/components/Monitor/monitor.test.tsx`

**Interfaces:**
- Consumes: Task 2 (`getProfile`, `getHistory`, `partyTimeline`, `getPresence`, `listMemberBills`, `searchSpeeches` with `mentionOf`, `listMemberSpeeches` filters), Task 5 (`parseDeputy`, `deputyHref`, `rollCallHref`), Task 6 (`DeputyCombobox` sm, `YearSelect`, `Pager`, `SortSwitch`).
- Page order: header (photo, name, party-UF, "Not in office now", "Official record", `ProfileLine`: profession · earlier mandates "Vereador(a) · Porto Alegre (RS) · 2009–2018, PSOL", `YearSelect`, `LanguageSwitch`, `DeputyCombobox` sm "Find a deputy") → `PartyTimeline` → `Positions` → `DeputySearch` + speeches (`p`) → `AuthoredBills` (`btype`, `bp`) → votes (rows link to `rollCallHref`; official bill link kept) → `Presence` → `Fronts`.
- `PartyTimeline({ locale, bands, today })`: server HTML; ≥ `sm`: one horizontal bar from 1 Feb 2023 to today, band widths by days, year ticks, out-of-office bands as neutral hatched gaps that are focusable (`tabIndex={0}`) with `title` and a visually hidden description; < `sm`: a list ("PSOL · since 1 Feb 2023", "Out of office · 3 Mar 2025 – 1 Apr 2025 · {description}"). Neutral greys only (colour is reserved for highlight types).
- `Positions({ locale, positions, today })`: titles other than Titular/Suplente first (body name, dates, "now" when `to` is null or ≥ today); memberships folded in `<details>` "Member of {n} committees".
- `DeputySearch`: GET form to the deputy page: `q`, `rel` as two radio-style options "Speeches by" / "Mentioning" (the topic is optional with Mentioning), From / To, Session phase, `SortSwitch`, Search. With `rel=mentions`, results come from `searchSpeeches({ mentionOf: { memberId, name }, terms })` and rows show the speaker (`showMember`).
- `AuthoredBills`: the counts line "RCP 1 · PL 4 · REQ 12" where each type is a link filtering by it (plus "All"), rows: "RCP 1/2026", date, ementa, official link `billUrl(id)`, a muted "co-author" when `!firstAuthor`; `Pager` on `bp`. Empty: "No bills or requests filed in 2026."
- `Presence({ locale, presence, year })`: `null` → "Presence not available for this deputy."; else the sentence "Present at {present} of {sessions} plenary deliberative sessions while in office ({year})", `<details>` "No presence recorded ({n})" listing date and the session's description, and the note line. Exact copy from the Global Constraints.
- `Fronts`: `<details>` "Member of {n} parliamentary fronts" with the titles.

- [ ] **Step 1: Write the failing tests:** `the timeline shows UNIÃO then PL and an out-of-office gap with its description`; `positions list leading roles first and fold memberships` (a "Presidente" row before "Member of 2 committees"); `presence is a record, never a score` (`Present at 78 of 81 plenary deliberative sessions while in office (2026)`; the HTML contains no `%` and no `absent`/`ausente`; `null` → "Presence not available for this deputy."); `a mention result highlights the name`; `authored bills show counts by type and mark co-authors`; `a vote row opens the roll-call page`; `the profile line merges earlier mandates` ("2009–2018").
- [ ] **Step 2: Run:** `pnpm --filter @digestor/web test monitor` — Expected: FAIL.
- [ ] **Step 3: Implement**, copy in both languages. The page loads everything with one `Promise.all` inside the existing Suspense; a search keeps the "Searching…" fallback.
- [ ] **Step 4: Run:** `pnpm --filter @digestor/web test && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Look at it:** `/monitor/deputados/204407` and `?q=feminicídio`, `?rel=mentions`, `?btype=RCP`, at 1280 and 390 px; tab through the timeline gaps; `errors.txt` empty.
- [ ] **Step 6: Commit** `feat(monitor): deputy workspace — timeline, positions, profile, bills, presence, fronts, mentions`.

### Task 8: The roll-call page

**Files:**
- Create: `apps/web/app/monitor/votacoes/[id]/page.tsx`, `apps/web/components/Monitor/RollCallView.tsx`
- Modify: `apps/web/messages/monitor.ts`
- Test: `apps/web/components/Monitor/monitor.test.tsx`

**Interfaces:**
- Consumes: Task 2 (`getRollCall`, `RollCallDetail`), Task 5 (`isRollCallId`, `deputyHref`).
- Page: `isRollCallId(id)` else `notFound()`; `getRollCall` null → `notFound()`. `RollCallView`: back link "Câmara monitor", `LanguageSwitch`; header: bill label (official link when `billId`), summary, what was voted, date, totals; "By party" (one block per party: name or "No party recorded", member count, counts as "Sim 12 · Não 3", deputies with UF and vote, each name links to `deputyHref`); "Party and bloc guidance" (each bloc: orientation, or "No guidance" when empty); the note "Party at the time of the vote, as published." No cohesion or other scores.

- [ ] **Step 1: Write the failing tests:** `votes are grouped by the party at the vote` (UNIÃO block holds the deputy now in PL; a name links to `/monitor/deputados/220576`); `empty guidance reads "No guidance"`; `isRollCallId` (`"2449741-72"` true; `"x"`, `"1-"`, `"../1-1"` false).
- [ ] **Step 2: Run:** `pnpm --filter @digestor/web test monitor` — Expected: FAIL.
- [ ] **Step 3: Implement**, copy in both languages.
- [ ] **Step 4: Run:** `pnpm --filter @digestor/web test && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Look at it:** `/monitor/votacoes/2449741-72` from a landing result and from 204407's votes, 1280 and 390 px.
- [ ] **Step 6: Commit** `feat(monitor): roll-call page with votes by party and the guidance list`.

### Task 9: Docs and the done-means pass

**Files:**
- Modify: `CLAUDE.md` (Câmara monitor section: routes `/monitor` params, `/monitor/deputados/[id]` params, `/monitor/votacoes/[id]`, `/api/monitor/deputies`; the new tables; the refresh order and the weekly profiles), `docs/deploy.md` (after migration 0023: rerun the backfill once, about N min from Task 4), `README.md` monitor lines if they name the routes.

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Run the spec's "Done means" on dev, both languages, 1280 and 390 px, with `digestor-run`; read every PNG; `errors.txt` empty. List what was seen in the ledger.
- [ ] **Step 3: Run:** `pnpm test`, then `pnpm test:worker`, then `pnpm typecheck` and `pnpm --filter @digestor/web build` — Expected: all PASS.
- [ ] **Step 4: Commit** `docs(monitor): workspace routes, tables and deploy step`.

Then the final whole-branch review (executing-plans / subagent-driven-development), its single fix pass, and
`finishing-a-development-branch`. Deploy is a separate step with its own "banana".
