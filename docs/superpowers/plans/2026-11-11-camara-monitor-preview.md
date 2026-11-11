# Câmara monitor preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A password-gated "Monitor" in Digestor: search Câmara deputies, speeches and roll calls (any query language), and a deputy page with their 2026 speeches and recorded votes, in English or Portuguese.

**Architecture:** Four new tables in Postgres (`parl_members`, `parl_speeches`, `parl_roll_calls`, `parl_votes`) with stored `tsvector` columns on a Portuguese, accent-insensitive text-search configuration. The worker fills them: a one-off backfill script from 1 Feb 2026 and a nightly `monitor.refresh` pg-boss job (deputies and speeches from the open-data API, roll calls and votes from the yearly bulk CSVs). The web app reads them through core repo functions on two server-rendered pages; a route handler translates the query into Portuguese terms with one OpenRouter call.

**Tech Stack:** Drizzle + Postgres 17 (`unaccent`, `pg_trgm`, full-text search), pg-boss 12, `csv-parse` (new worker dependency), Next.js 16 App Router, vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-camara-monitor-preview-design.md`

## Global Constraints

- Official data only. The only LLM call is query translation; no AI text about a person anywhere.
- A deputy page's search covers that deputy's **speeches only**; votes stay in their own unfiltered list. Roll-call search results show bill, what was voted and totals, **never an individual deputy's vote**.
- Votes list shows recorded votes only, plus one muted line: roll calls without a recorded vote are not listed. Labels as published: Sim, Não, Abstenção, Obstrução, Art. 17.
- Period: from `2026-02-01`. Deputies: everyone in exercise in the 57th legislature since then; `inOffice=false` → "Not in office now".
- Links: deputy `https://www.camara.leg.br/deputados/{id}`; bill `https://www.camara.leg.br/propostas-legislativas/{idProposicao}`; speeches get no link. No fetching of `www.camara.leg.br` pages or trecho URLs by code.
- Câmara API: at most 4 requests in flight (`mapLimit`), the existing `get`/`getJson` helpers in `apps/worker/src/records/http.ts`.
- Query: max 200 characters. Translation returns 1–4 Portuguese terms, each ≤ 60 characters; shown as "Searched for: …"; on failure search the query as typed with a notice.
- Interface languages: `en` and `pt-BR`, cookie `monitor_lang`; default from `Accept-Language` (`pt*` → `pt-BR`, else `en`). Official data is shown as published in both.
- Digestor's existing screens, `t()` and `messages/en.ts` stay unchanged except one AppBar link ("Monitor").
- Conventions from CLAUDE.md: core uses `.ts` relative imports, worker `.js`; repo functions in `@digestor/core/server`; worker tests run in the container; UI follows the `digestor-ui` skill; structured LLM output follows `llm-structured-output`; fixtures follow `vendor-contract-check`.
- Cut-off Thu 12 Nov night. Tasks 7 and 8 are droppable; nothing in Tasks 1–6 may depend on them.

## Review Focus

1. A query of only stop words or punctuation ("o", "!!!", "  ") → no SQL error, "No results" (Task 2 test `empty tsquery`).
2. The API answers 200 with an empty list for a deputy whose speeches are already stored (the Câmara does this when it breaks) → stored speeches are kept, a warning is logged (Task 5 test `keeps speeches on an empty answer`).
3. A speech whose `transcricao` is empty (not transcribed yet) → listed with its summary and "Full text not published yet"; a later refresh fills it (Task 2 test `replaces a window`, Task 6 render).
4. A deputy with no speeches and no votes (an alternate) → page renders both empty states, no crash (Task 6 test).
5. The language switch's `back` parameter pointing off-site (`//evil.example`, `https://…`) → redirect to `/monitor` only (Task 7 test).

---

### Task 1: Tables, text-search configuration and migration 0022 (≈1.5 h)

**Files:**
- Modify: `packages/core/src/db/schema.ts` (append the four tables), `packages/core/src/server.ts` (export them)
- Create: `packages/core/drizzle/0022_parliament_monitor.sql` (generated with `pnpm --filter @digestor/core db:generate`, then edited by hand), meta snapshot + journal
- Test: `packages/core/src/db/monitor.test.ts` (first test only)

**Interfaces:**
- Produces tables (Drizzle names → SQL):
  - `parlMembers` → `parl_members`: `id serial pk`, `house text not null` (`"camara"`), `externalId integer not null`, `name text not null`, `nameNorm text not null` (lower-case, accents stripped in code), `party text`, `uf text`, `photoUrl text`, `inOffice boolean not null default false`, `updatedAt timestamptz not null default now()`; unique `(house, external_id)`; GIN trigram index on `name_norm`.
  - `parlSpeeches` → `parl_speeches`: `id serial pk`, `memberId integer not null → parl_members.id on delete cascade`, `startsAt timestamp not null` (Brasília local time, no zone), `phase text`, `kind text`, `summary text not null default ''`, `text text not null default ''`, `keywords text not null default ''`, `tsv tsvector generated always as (setweight(to_tsvector('pt_unaccent', summary || ' ' || keywords), 'A') || setweight(to_tsvector('pt_unaccent', text), 'B')) stored`; index `(member_id, starts_at)`, GIN on `tsv`.
  - `parlRollCalls` → `parl_roll_calls`: `id text pk` (votação id, e.g. `"2449741-72"`), `house text not null`, `date date not null`, `registeredAt timestamp`, `description text not null`, `yes integer not null`, `no integer not null`, `other integer not null`, `billId integer`, `billLabel text` (e.g. `"PL 3880/2024"`), `billSummary text not null default ''`, `tsv` generated `setweight(to_tsvector('pt_unaccent', bill_summary), 'A') || setweight(to_tsvector('pt_unaccent', description), 'B')`; GIN on `tsv`, index on `date`.
  - `parlVotes` → `parl_votes`: `rollCallId text → parl_roll_calls.id on delete cascade`, `memberId integer → parl_members.id on delete cascade`, `vote text not null`; pk `(roll_call_id, member_id)`, index `member_id`.
- Migration head (hand-written, before the tables):

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
ALTER TEXT SEARCH CONFIGURATION pt_unaccent ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;
```

Use a Drizzle `customType` for `tsvector` and `.generatedAlwaysAs(sql\`…\`)`.

- [ ] **Step 1: Failing test** `monitor.test.ts › "pt_unaccent matches across accents and plural"`: insert a member and a speech with text `"Os feminicídios no Rio Grande do Sul"`; `select count(*) from parl_speeches where tsv @@ websearch_to_tsquery('pt_unaccent', 'feminicidio')` → `1`.
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test monitor` → FAIL (table missing).
- [ ] **Step 3: Add the tables, generate, hand-edit the migration head, run** `pnpm db:migrate` (dev).
- [ ] **Step 4: Run** the test → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(monitor): parliament tables and Portuguese full-text search config (migration 0022)`.

### Task 2: Repo functions (≈2 h)

**Files:**
- Create: `packages/core/src/db/monitor.ts`, `packages/core/src/monitorText.ts` (pure helpers, client-safe)
- Modify: `packages/core/src/server.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/db/monitor.test.ts`, `packages/core/src/monitorText.test.ts`

**Interfaces:**
- Produces (in `monitorText.ts`, exported from `@digestor/core`):
  - `normName(s: string): string` — NFD, strip combining marks, lower-case, collapse spaces.
  - `HIGHLIGHT_START = "\u0001"`, `HIGHLIGHT_END = "\u0002"`; `splitHighlights(s: string): { text: string; hit: boolean }[]`.
- Produces (in `db/monitor.ts`, from `@digestor/core/server`):
  - `type MemberInput = { house: "camara"; externalId: number; name: string; party: string | null; uf: string | null; photoUrl: string | null }`
  - `upsertMembers(db, rows: MemberInput[]): Promise<Map<number, number>>` (externalId → id)
  - `setInOffice(db, house: "camara", externalIds: number[]): Promise<void>` (true for these, false for the rest of the house)
  - `type SpeechInput = { startsAt: string /* "2026-10-27T18:24" */; phase: string | null; kind: string | null; summary: string; text: string; keywords: string }`
  - `replaceSpeechWindow(db, memberId: number, from: string, to: string /* YYYY-MM-DD, inclusive */, rows: SpeechInput[]): Promise<{ deleted: number; inserted: number }>` — one transaction: delete the member's speeches with `starts_at` in the window, insert `rows`.
  - `countSpeechesInWindow(db, memberId, from, to): Promise<number>`
  - `type RollCallInput = { id: string; date: string; registeredAt: string | null; description: string; yes: number; no: number; other: number; billId: number | null; billLabel: string | null; billSummary: string }`
  - `upsertRollCalls(db, rows: RollCallInput[]): Promise<void>`; `rollCallIdsWithBill(db, ids: string[]): Promise<Set<string>>`
  - `replaceVotes(db, rollCallId: string, rows: { memberId: number; vote: string }[]): Promise<void>`
  - `searchMembers(db, q: string, limit = 8): Promise<MemberRow[]>` — `name_norm ILIKE '%' || normName(q) || '%'` ordered by `similarity(name_norm, normName(q)) desc`.
  - `searchSpeeches(db, a: { terms: string[]; memberId?: number; limit?: number /*20*/; offset?: number }): Promise<{ total: number; rows: SpeechHit[] }>` — tsquery = the terms' `websearch_to_tsquery('pt_unaccent', term)` joined with `||`; rank `ts_rank_cd(tsv, q)` desc then `starts_at` desc; `ts_headline('pt_unaccent', summary || ' … ' || text, q, 'StartSel=\u0001,StopSel=\u0002,MaxFragments=2,MaxWords=30,MinWords=10')` computed only for the page's rows (subquery).
  - `searchRollCalls(db, a: { terms: string[]; limit?: number /*10*/ }): Promise<RollCallHit[]>` (only rows with `yes + no + other > 0`; no member data).
  - `getMember(db, house: "camara", externalId: number): Promise<MemberRow | null>`
  - `listMemberSpeeches(db, memberId, a: { limit?: number /*50*/; offset?: number }): Promise<{ total: number; rows: SpeechRow[] }>` (newest first)
  - `listMemberVotes(db, memberId, a: { limit?: number /*100*/; offset?: number }): Promise<{ total: number; rows: VoteRow[] }>` (newest first; joins roll call)
  - Row types: `MemberRow = { id; externalId; name; party; uf; photoUrl; inOffice }`, `SpeechRow = { id; startsAt; phase; kind; summary; text }`, `SpeechHit = SpeechRow & { member: Pick<MemberRow, "externalId" | "name" | "party" | "uf">; snippet: string }`, `RollCallHit = { id; date; description; yes; no; other; billId; billLabel; snippet: string }`, `VoteRow = { rollCallId; date; description; billId; billLabel; billSummary; vote }`.

- [ ] **Step 1: Failing tests** in `monitor.test.ts` (TRUNCATE the four tables in `beforeEach`):
  - `"searchMembers finds Melchionna without accents or case"`: upsert `Fernanda Melchionna` and `Fernando Máximo`; `searchMembers(db, "melchion")` → one row named `Fernanda Melchionna`.
  - `"searchSpeeches ORs the terms and filters by member"`: speeches "feminicídio no RS" (member A), "violência contra a mulher" (member B), "orçamento" (A); terms `["feminicídio", "violência contra a mulher"]` → total 2; with `memberId: A` → total 1; snippet contains `\u0001`.
  - `"empty tsquery"`: terms `["o"]` and `["!!!"]` → `{ total: 0, rows: [] }`, no throw.
  - `"searchRollCalls skips symbolic votes"`: one roll call 408/13 with bill summary "monitoramento eletrônico para agressores em casos de violência doméstica", one 0/0/0 with the same text; terms `["violência doméstica"]` → 1 row.
  - `"replaces a window"`: insert two speeches on `2026-11-09` and one on `2026-10-01`; `replaceSpeechWindow(db, A, "2026-11-04", "2026-11-11", [one row])` → `{ deleted: 2, inserted: 1 }`, the October row still there.
  - `"listMemberVotes lists recorded votes only, newest first"`.
  - `monitorText.test.ts`: `normName("  Fernanda   MELCHIONNA ")` → `"fernanda melchionna"`; `normName("Máximo")` → `"maximo"`; `splitHighlights("a \u0001b\u0002 c")` → `[{text:"a ",hit:false},{text:"b",hit:true},{text:" c",hit:false}]`.
- [ ] **Step 2: Run** `pnpm --filter @digestor/core test monitor` → FAIL.
- [ ] **Step 3: Implement** the functions above with Drizzle + `sql` for the full-text parts.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(monitor): repo functions for members, speeches, roll calls and search`.

### Task 3: Câmara monitor client and recorded fixtures (≈1.5 h)

**Files:**
- Create: `apps/worker/src/monitor/camara.ts`, `apps/worker/test/fixtures/camara-monitor/` (`deputados-2026.recorded.json` trimmed to 3 deputies incl. 204407, `deputados-em-exercicio.recorded.json` trimmed, `discursos-204407.recorded.json` trimmed to 4 speeches incl. one with empty `transcricao`, `proposicao-3880-2024.recorded.json`, `votacoes-2026.excerpt.csv`, `votacoesObjetos-2026.excerpt.csv`, `votacoesVotos-2026.excerpt.csv` — the excerpts keep the header, roll calls `2449741-72`, `2462009-57`, one urgency roll call with no objects (`2600277-9`), and one symbolic votação; `_meta` notes in a sibling `README.md` with date and URLs)
- Test: `apps/worker/src/monitor/camara.test.ts`

**Interfaces:**
- Consumes: `get`, `getJson`, `mapLimit` from `../records/http.js`.
- Produces:
  - `MONITOR_FROM = "2026-02-01"`
  - `fetchMembers(f: typeof fetch, from: string, to: string): Promise<MemberInput[]>` — `GET /deputados?dataInicio&dataFim&itens=100&ordem=ASC&ordenarPor=nome`, following `links` rel `next`.
  - `fetchInOfficeIds(f): Promise<number[]>` — `GET /deputados?itens=100` paged.
  - `fetchSpeeches(f, externalId: number, from: string, to: string): Promise<SpeechInput[]>` — `GET /deputados/{id}/discursos?dataInicio&dataFim&itens=100&ordenarPor=dataHoraInicio&ordem=ASC`, paged; 404 → `[]` and a log line; maps `faseEvento.titulo` → `phase`, `tipoDiscurso` → `kind`, `sumario ?? ""`, `transcricao ?? ""`, `keywords ?? ""`.
  - `fetchYearCsv(f, kind: "votacoes" | "votacoesObjetos" | "votacoesVotos", year: number): Promise<string>` — `https://dadosabertos.camara.leg.br/arquivos/{kind}/csv/{kind}-{year}.csv`.
  - `fetchBill(f, a: { id?: number; label?: string }): Promise<{ id: number; label: string; summary: string } | null>` — by id `GET /proposicoes/{id}`, by label `GET /proposicoes?siglaTipo&numero&ano`.

- [ ] **Step 1: Record** the fixtures once from the live API (scratchpad script, not committed), trim them, write `README.md` with the URLs and `2026-11-11`.
- [ ] **Step 2: Failing tests** (fake `fetch` serving the fixtures by URL, `httpTiming.delayMs = 0`): `fetchMembers` maps 204407 to `{ externalId: 204407, name: "Fernanda Melchionna", party: "PSOL", uf: "RS", … }`; `fetchSpeeches` returns 4 rows ordered by `startsAt` with the empty-text one having `text: ""`; a page with `links` rel `next` is followed; a 404 gives `[]`.
- [ ] **Step 3: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test monitor/camara` → FAIL.
- [ ] **Step 4: Implement**; **Step 5:** PASS.
- [ ] **Step 6: Add a row** for "Câmara monitor (bulk CSVs, /deputados, /proposicoes)" to the table in `.claude/skills/vendor-contract-check/SKILL.md`: CSV with `;`, BOM, quoted fields with newlines; files regenerated nightly 04:00–07:10 UTC; only roll calls have per-deputy rows; `proposicao_titulo` `"X => PL n/aaaa"` names the main bill; urgency requests may have no objects.
- [ ] **Step 7: Commit** `feat(monitor): Câmara client for deputies, speeches, bulk roll-call files and bills`.

### Task 4: Roll calls and votes from the bulk files (≈1 h)

**Files:**
- Create: `apps/worker/src/monitor/rollCalls.ts`; add `csv-parse` to `apps/worker/package.json` (`pnpm add csv-parse --filter @digestor/worker` on the host, then restart the worker)
- Test: `apps/worker/src/monitor/rollCalls.test.ts`

**Interfaces:**
- Produces:
  - `parseCsv(text: string): Record<string, string>[]` (`csv-parse/sync`, `delimiter: ";"`, `bom: true`, `columns: true`, `relax_quotes: true`)
  - `mainBill(objects: Record<string, string>[]): { label: string; id: number | null; summary: string } | null`
  - `toRollCalls(votacoes, objetos): (RollCallInput & { needsBill: { id?: number } | null })[]` — only `siglaOrgao === "PLEN"` and `votosSim + votosNao + votosOutros > 0`.
  - `toVotes(votos): Map<string, { externalId: number; name: string; party: string; uf: string; vote: string }[]>` keyed by roll call id.
- `mainBill` rule (not determined by a test alone): count `proposicao_titulo` matches of `/=>\s*([A-Z]+ \d+\/\d{4})/` per label; objects with a `proposicao_ano` and a main type (`PL, PLP, PEC, MPV, PDL, PRC, PLV`) count as their own `"SIGLA n/aaaa"` label with weight 1; the label with the highest count wins. Its id and summary come from an object whose own `siglaTipo numero/ano` equals the label, else `id: null, summary: ""` (filled by `fetchBill` in Task 5). No match → `null`, and `needsBill: { id: ultimaApresentacaoProposicao_idProposicao }` when that column has a number.

- [ ] **Step 1: Failing tests** on the CSV excerpts: `2449741-72` → `billLabel "PL 2942/2024"`, `yes 408`, `no 13`; `2462009-57` → `"PL 3880/2024"`; `2600277-9` → `billLabel null`, `needsBill.id` a number; the symbolic votação is absent; `toVotes` gives 204407 `"Sim"` on `2449741-72` and `"Não"` on `2462009-57`; a field with an embedded newline parses as one row.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(monitor): roll calls, main bill and votes from the Câmara bulk files`.

### Task 5: Refresh job, backfill script, schedule (≈1.5 h)

**Files:**
- Create: `apps/worker/src/monitor/refresh.ts`, `apps/worker/scripts/monitor-backfill.ts`
- Modify: `apps/worker/src/main.ts` (queue + schedule + worker, like `RECORDS_RETRY_QUEUE`)
- Test: `apps/worker/src/monitor/refresh.test.ts` (real test DB, fake fetch on the fixtures)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `MONITOR_REFRESH_QUEUE = "monitor.refresh"`, `MONITOR_REFRESH_CRON = "0 9 * * *"` (UTC, after the bulk files are regenerated)
  - `refreshMonitor(deps: { db: Db; fetch: typeof fetch }, a: { speechesFrom: string; to: string; year: number }): Promise<{ members: number; speeches: { inserted: number; kept: number }; rollCalls: number; votes: number; bills: number }>`
  - Order: members (`fetchMembers(MONITOR_FROM, to)` + `setInOffice(fetchInOfficeIds)`) → speeches per member with `mapLimit(…, 4)` → roll calls (three CSVs; vote rows whose deputy is unknown are upserted as members from the CSV's name/party/uf) → bills: `fetchBill` only for roll calls in `needsBill` or with `billLabel` but `billId null`, skipping ids already in `rollCallIdsWithBill`.
  - **Empty-answer guard:** when `fetchSpeeches` returns `[]` and `countSpeechesInWindow > 0`, skip the replace, count it in `kept`, `console.warn` once per run with the number of such deputies.
  - The job: `refreshMonitor({ speechesFrom: today − 7 days, to: today, year: current year })`, one `console.log("monitor.refresh:", counts)`.
  - Backfill script: same function with `speechesFrom: MONITOR_FROM`; usage `docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/monitor-backfill.ts`.

- [ ] **Step 1: Failing tests:** a full run on the fixtures → member 204407 present with `inOffice` per the fixture, 4 speeches, roll calls `2449741-72` and `2462009-57` with labels and her votes; rerun → same counts (idempotent); `"keeps speeches on an empty answer"`: second run where her discursos fixture is `{ dados: [] }` → her speeches still 4, `kept: 1`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, wire the queue in `main.ts` (create/update queue with `JOB_OPTIONS`, `boss.schedule(..., { tz: "UTC" })`, `boss.work`). **Step 4: Run** → PASS; `pnpm test:worker` all green.
- [ ] **Step 5: Run the backfill on dev**; record the counts and run time in the commit message. Check by hand: `searchSpeeches(["feminicídio"], memberId of 204407)` returns her speeches.
- [ ] **Step 6: Commit** `feat(monitor): nightly refresh job and 2026 backfill`.

### Task 6: Monitor pages in English (≈3 h)

**Files:**
- Create: `apps/web/messages/monitor.ts` (English catalogue `monitorEn` only; Task 7 adds `pt-BR`), `apps/web/lib/monitor/i18n.ts`, `apps/web/lib/monitor/search.ts`, `apps/web/app/monitor/page.tsx`, `apps/web/app/monitor/deputados/[id]/page.tsx`, `apps/web/components/Monitor/` (`SearchBox.tsx`, `SpeechItem.tsx`, `RollCallItem.tsx`, `VoteRow.tsx`, `Highlighted.tsx`)
- Modify: `apps/web/components/AppBar.tsx` (a "Monitor" link after "Sessions"; key `appBar.monitor` in `messages/en.ts`)
- Test: `apps/web/lib/monitor/search.test.ts`, `apps/web/lib/monitor/i18n.test.ts`, `apps/web/components/Monitor/*.test.tsx` (as the existing component tests do)

**Interfaces:**
- Consumes: Task 2 functions; `splitHighlights`.
- Produces:
  - `type MonitorLocale = "en" | "pt-BR"`; `tm(locale: MonitorLocale, key: MonitorKey, vars?)` (same interpolation rules as `t()`); `monitorLocale(cookie: string | undefined, acceptLanguage: string | null): MonitorLocale` returns `"en"` in this task (Task 7 implements it). Pages call it and pass the locale down, so Task 7 changes no page structure.
  - `type TranslateResult = { terms: string[]; translated: boolean; failed: boolean }`, declared in `search.ts` (Task 8 provides a translator).
  - `runSearch(db, q: string, translate?: (q: string) => Promise<TranslateResult>): Promise<{ q: string; terms: string[]; translatedFrom: string | null; notice: "translationFailed" | null; members: MemberRow[]; speeches: { total; rows: SpeechHit[] }; rollCalls: RollCallHit[] }>` — trims and caps `q` at 200 characters; empty `q` → no queries; without `translate`, `terms = [q]`.
- Pages: `/monitor?q=` (search box, then sections Deputies, Speeches, Roll calls, each with an empty state; "Searched for: …" line); `/monitor/deputados/[id]?q=` (header with photo, name, party-UF, "Not in office now" when `!inOffice`, official link; a speech search box limited to this deputy; Speeches list newest first with `<details>` for the full text or "Full text not published yet"; Votes list newest first with the muted note). Server components with `await connection()` inside `Suspense`, as `app/reports/page.tsx` does. `id` not a positive integer or unknown → `notFound()`.
- Copy (English, exact): page title "Câmara monitor"; search placeholder "Search a deputy or a topic"; section titles "Deputies", "Speeches", "Roll calls", "Votes"; "Searched for: {terms}"; "Not in office now"; "Full text not published yet"; "Roll calls without a recorded vote are not listed."; "Official record"; empty states "No deputies match.", "No speeches match.", "No roll calls match.", "No speeches in 2026.", "No recorded votes in 2026."; data note under the title "Official records of the Câmara dos Deputados since 1 February 2026, updated nightly."

- [ ] **Step 1: Failing tests:** `runSearch` with `q = "x".repeat(300)` passes a 200-character query; empty `q` returns empty groups without touching the DB; `Highlighted` renders `<mark>` for hit parts and never uses `dangerouslySetInnerHTML`; `VoteRow` renders the vote label exactly as given; the deputy page component renders both empty states for a member with no rows (Review Focus 4).
- [ ] **Step 2: Run** `pnpm --filter @digestor/web test monitor` → FAIL. **Step 3: Implement** (read the `digestor-ui` and `nextjs16-gotchas` skills first). **Step 4:** PASS; `pnpm typecheck`.
- [ ] **Step 5: See it** with the `digestor-run` skill: search "Fernanda Melchionna" and "feminicídio" on dev, open her page, screenshot at desktop and phone width; no console errors.
- [ ] **Step 6: Commit** `feat(monitor): search page and deputy page`.

### Task 7: Portuguese interface and language switch (≈1.5 h, droppable)

**Files:**
- Modify: `apps/web/messages/monitor.ts` (add `monitorPtBR`, typed `satisfies typeof monitorEn`'s shape), `apps/web/lib/monitor/i18n.ts`, both monitor pages (read the cookie, pass the locale down)
- Create: `apps/web/app/monitor/lang/route.ts`, `apps/web/components/Monitor/LanguageSwitch.tsx`
- Test: `apps/web/lib/monitor/i18n.test.ts`, `apps/web/app/monitor/lang/route.test.ts`

**Interfaces:**
- `GET /monitor/lang?to=pt-BR|en&back=<path>` sets cookie `monitor_lang` (`path=/`, 1 year, `SameSite=Lax`) and redirects (303) to `back` when it starts with `/monitor` and not `//`, else to `/monitor`.
- `monitorLocale(cookie, acceptLanguage)`: valid cookie wins; else `pt*` → `"pt-BR"`; else `"en"`.
- Dates and numbers through `formatDateTime`/`formatNumber` with the locale.

- [ ] **Step 1: Failing tests:** every key in `monitorEn` exists in `monitorPtBR` and vice versa; `monitorLocale(undefined, "pt-BR,pt;q=0.9")` → `"pt-BR"`; `monitorLocale("en", "pt-BR")` → `"en"`; `monitorLocale("xx", null)` → `"en"`; the route with `back=//evil.example` and `back=https://evil.example` redirects to `/monitor` (Review Focus 5); with `back=/monitor/deputados/204407?q=a` keeps it.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (Portuguese copy: "Monitor da Câmara", "Busque um deputado ou um tema", "Deputados", "Discursos", "Votações nominais", "Votos", "Buscado: {terms}", "Fora do exercício", "Texto integral ainda não publicado", "Votações sem voto registrado não aparecem.", "Registro oficial", "Registros oficiais da Câmara dos Deputados desde 1º de fevereiro de 2026, atualizados diariamente."; the owner reviews the rest). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(monitor): Portuguese interface and language switch`.

### Task 8: Search in any language (≈2 h, droppable)

**Files:**
- Create: `apps/web/lib/monitor/translateQuery.ts`
- Modify: `apps/web/lib/monitor/search.ts` callers (pages pass `translate` when `OPENROUTER_API_KEY` is set)
- Test: `apps/web/lib/monitor/translateQuery.test.ts`

**Interfaces:**
- `TranslateResult` from `search.ts` (Task 6).
- `translateQuery(q: string, o: { apiKey: string; model?: string /* OPENROUTER_MODEL_FAST ?? "anthropic/claude-haiku-5.5" */; fetch?: typeof fetch; timeoutMs?: number /* 10_000 */ }): Promise<TranslateResult>` — one `POST https://openrouter.ai/api/v1/chat/completions` with `response_format: { type: "json_schema", json_schema: { name: "search_terms", strict: true, schema: { type: "object", properties: { terms: { type: "array", items: { type: "string" } } }, required: ["terms"], additionalProperties: false } } }`, `provider: { require_parameters: true }`, no sampling parameters (Claude 5.5), header `X-OpenRouter-Title: Digestor`. Validate with zod after the call (`{ terms: string[] }`), then in code: trim, drop empty, cut each to 60 characters, keep at most 4, dedupe case-insensitively. No terms, a non-2xx, a timeout or invalid JSON → `{ terms: [q], translated: false, failed: true }`. `translated` is false when the only term equals `q` ignoring case and accents.
- System prompt (exact): "You turn a search query into Portuguese (Brazil) search terms for the official records of the Brazilian Chamber of Deputies. Return the direct translation first, then up to 3 close terms a speech might use instead. Keep personal names, party names and bill numbers as written. If the query is already Portuguese, return it first unchanged. Return only search terms, never sentences or explanations." The query goes in the user message as data.
- In-memory cache: `Map` of up to 500 normalised queries (drop the oldest), successful results only.

- [ ] **Step 1: Failing tests** with an injected fetch: "femicide" → reply `{"terms":["feminicídio","violência contra a mulher","assassinato de mulheres"]}` → those 3 terms, `translated: true`; reply with 7 terms and one of 200 characters → 4 terms, none over 60; a Portuguese query whose reply repeats it → `translated: false`; 500, timeout (`timeoutMs: 20`, hanging fetch) and `"not json"` → `failed: true, terms: [q]`; the request body has no `temperature` and has `response_format.type === "json_schema"`; a second identical call does not hit fetch (cache).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; wire into both pages; the "Searched for" line shows all terms and, when `translated`, "(from “{q}”)"; when `failed`, the notice "Couldn't translate the search; searched for your words as typed." (pt-BR: "Não foi possível traduzir a busca; buscamos as palavras como foram digitadas."). **Step 4:** PASS.
- [ ] **Step 5: Check on dev** with the real key: "femicide" and "Femizid" find her speeches. **Step 6: Commit** `feat(monitor): search in any language through query translation`.

### Task 9: Docs and demo check (≈1 h)

**Files:** `CLAUDE.md` (Monitor routes, tables, queue `monitor.refresh` and its cron, backfill command in the Commands table), `README.md` (one paragraph under features), `docs/deploy.md` (prod steps below).

- [ ] **Step 1:** Update the three docs.
- [ ] **Step 2: Full check:** `pnpm test`, `pnpm test:worker`, `pnpm typecheck` green; the `digestor-run` demo path (name search → her page → "feminicídio" → "femicide" → switch language) with screenshots; delete any test sessions/files created.
- [ ] **Step 3: Commit** `docs(monitor): commands, routes and deploy steps`.

### Task 10: Deploy to prod (≈1 h, needs the owner's "banana")

Order on the server (`docs/deploy.md`): `git pull` → `docker compose up -d --build` (runs migrations 0021 and 0022) → backfill script once → open `/monitor` behind the password and run the demo path → check the next morning's `monitor.refresh` log line. Prod has no `OPENROUTER_API_KEY` problem (it runs on OpenRouter already) but confirm the web container sees it (`env_file: .env`).
