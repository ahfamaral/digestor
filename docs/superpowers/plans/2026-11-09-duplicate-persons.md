# Duplicate Person Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One person row per real person: a transcript/caption/typed name and an official record of the same person share one row, so non-evaluated houses (US Senate) stop ending in "conflict → unnamed".

**Architecture:** Name lookup prefers official rows; the record step folds a same-name custom row into the official one (re-pointing its references and deleting it); a one-off idempotent script merges the pairs already in the database.

**Tech Stack:** TypeScript, Drizzle (Postgres), vitest.

**Spec:** no spec doc. Source: `docs/superpowers/plans/2026-11-04-plan-4-deferred.md` line 10 (Task 12 follow-up) and the owner's go on 2026-11-09 for the fix described in chat. Branch `fix-duplicate-persons` from `main`.

## Global Constraints

- A merge happens only on an **exact** normalised name match (`normaliseName`, `packages/core/src/attribution.ts`): the custom row's `displayName` equals the official row's `displayName` or `fullName`. Short forms ("Lula", "Rep. Pelosi") never merge.
- A custom row merges only when **exactly one** official person carries that normalised name (homonym guard). Two official rows with the name → no merge.
- Only `kind = "custom"` rows are ever deleted; official rows are never merged into each other.
- Persons are referenced by `attributions.person_id` and `find_more_requests.person_id` (unique on owner, analysis, person). A merge re-points both in one transaction.
- Relative imports in `packages/core` use `.ts`; the worker uses `.js`.

## Review Focus

1. Two custom rows with the same name (the dev DB has "Ana Souza" ×2, both owner-made) and no official row: nothing merges, nothing is deleted.
2. A custom row that has a `find_more_requests` row for the same owner + analysis as the official row: the merge must not violate the unique constraint (drop the custom row's request, keep the official one).
3. A human (`source = "human"`) attribution pointing at the custom row keeps its status and source after re-pointing; only `person_id` changes.
4. The merge runs inside `upsertOfficialPerson`'s transaction: a failure leaves both rows as they were.
5. Two official persons from different houses with the same display name (e.g. a Bundestag and a US member): a custom row of that name is not merged into either.

---

### Task 1: Merge in core (lookup, merge, record upsert)

**Files:**
- Modify: `packages/core/src/db/names.ts` (`findPersonByName`, `upsertOfficialPerson`; new `mergePersonInto`, `mergeSameNamePersons`)
- Test: `packages/core/src/db/names.test.ts` (describe "persons")

**Interfaces:**
- Produces:
  - `findPersonByName(db, name): Promise<Person | null>`: same matching as today; among hits, official rows first, then oldest `createdAt`.
  - `mergePersonInto(tx: Db, keepId: string, dropId: string): Promise<void>`: re-points `attributions.person_id` and `find_more_requests.person_id` from `dropId` to `keepId` (deleting a drop request that would collide with an existing keep request on owner + analysis), then deletes the `dropId` person. Refuses (throws) if `dropId` is not `kind = "custom"`.
  - `mergeSameNamePersons(db, opts?: { names?: string[] }): Promise<{ merged: number }>`: for each custom row whose normalised `displayName` equals the normalised `displayName` or `fullName` of exactly one official row, merges it into that row. `opts.names` limits the check to those names (used by the upsert); without it, all custom rows (used by the script).
  - `upsertOfficialPerson`: unchanged signature; after inserting or updating the official row, in the same transaction, merges same-name custom rows into it (`mergeSameNamePersons` scoped to its `displayName` and `fullName`).

- [ ] **Step 1: Write the failing tests** in `names.test.ts` → describe "persons":
  - `findPersonByName prefers the official row over an older custom row of the same name`: create custom "Dirk Vöpel" first, then `upsertOfficialPerson({ idSystem: "bundestag", officialId: "11004433", displayName: "Dirk Vöpel", fullName: "Dirk Vöpel" })`; expect `findPersonByName(db, "dirk vopel")` to have `officialIds.bundestag === "11004433"`. (With the merge also in place this row is the only one; keep the assertion — it pins the outcome.)
  - `upsertOfficialPerson folds a same-name custom row into the official one`: custom "Steffen Bilger" with a proposed `transcript` attribution and a human attribution on session `s`; upsert official "Steffen Bilger"; expect one person row of that name, both attributions now point at the official id, the human row still `source: "human"`, `status: "confirmed"`, and `personAt(listAttributions(...), "B", 0)` is `named`.
  - `a short form is not merged`: custom "Bilger" + official "Steffen Bilger" → two rows remain.
  - `no merge when two official persons share the name`: official bundestag "Max Muster" and official bioguide "Max Muster" + custom "Max Muster" → custom row still exists.
  - `two custom rows of the same name and no official row stay`: `mergeSameNamePersons(db)` → `{ merged: 0 }`, both rows exist.
  - `a colliding find_more request is dropped, not duplicated`: custom and official "Anna Muster" each have a `find_more_requests` row for the same owner + analysis; after `mergeSameNamePersons(db)` one request remains, on the official person.
  - `mergeSameNamePersons is idempotent`: second call → `{ merged: 0 }`.
  - `mergePersonInto refuses to delete an official row`: expect it to throw.

- [ ] **Step 2: Run to verify they fail**
  Run: `pnpm --filter @digestor/core test names`
  Expected: the new tests FAIL (missing exports / two rows remain); existing tests pass.

- [ ] **Step 3: Implement** the four functions in `names.ts`. Candidate matching is done in TS with `normaliseName` over `select` results (as `findPersonByName` does; the table is small). Take `pg_advisory_xact_lock(hashtext('persons:merge'))` inside the merge transaction so two record runs can't merge the same row twice.

- [ ] **Step 4: Run to verify they pass**
  Run: `pnpm --filter @digestor/core test` and `pnpm typecheck`
  Expected: all core tests PASS, typecheck clean.

- [ ] **Step 5: Commit**
  `git commit -m "fix(names): one person row per name: prefer official, fold same-name custom rows into the record person"`

### Task 2: Worker proof (US Senate) and the one-off script

**Files:**
- Test: `apps/worker/src/pipeline/naming.test.ts` (describe "runRecordStep through a connector")
- Create: `apps/worker/scripts/merge-persons.ts`
- Modify: `CLAUDE.md` (Commands table), `docs/deploy.md` (next to the `import-names.ts` line)

**Interfaces:**
- Consumes: `mergeSameNamePersons(db)` from Task 1 (`@digestor/core/server`).

- [ ] **Step 1: Write the failing test** `a non-evaluated house (US Senate): a transcript name and the record person of the same name name the voice, no conflict`. Session linked to a `us_senate` record via a fake connector (same shape as `fakeBundestag` in that describe, `chamber: "us_senate"`, member `{ displayName: "Anna Muster" }`). Before the record step, create a custom "Anna Muster" with a proposed `transcript` attribution on the voice the record matches. After `runRecordStep`, expect `personAt(...)` for that voice to be `{ kind: "named", confirmed: false }` with the official person id, and exactly one person named "Anna Muster".
  Note: this test passes as soon as Task 1 is in; run it against Task 1's parent commit (`git stash` the core change or check out `main` core) to see it fail, and record that run in the report.

- [ ] **Step 2: Run** `docker compose run --rm worker pnpm --filter @digestor/worker test naming`
  Expected: PASS with Task 1; FAIL (`conflict`) without it.

- [ ] **Step 3: Write `scripts/merge-persons.ts`**: connects with `DATABASE_URL`, calls `mergeSameNamePersons(db)`, prints `merged N duplicate person(s)`, exits. Add a Commands row "Merge duplicate persons (once, idempotent)" in `CLAUDE.md` and the prod line in `docs/deploy.md`.

- [ ] **Step 4: Run it on the dev DB** (controller step, not the implementer's):
  `docker compose exec worker pnpm --filter @digestor/worker exec tsx scripts/merge-persons.ts`
  Expected: `merged 8 duplicate person(s)` (the 8 Bundestag pairs: Daniel Kölbl, Dirk Vöpel, Günter Baumgartner, Matthias Gastel, Maximilian Kneller, Sören Pellmann, Steffen Bilger, Wolfgang Wiehle); a second run prints `merged 0`. "Ana Souza" ×2 stays. Then open the Bundestag session b3e26a69 Who's who and check the names still show.

- [ ] **Step 5: Full suites and commit**
  Run: `pnpm test`, `pnpm typecheck`, `pnpm test:worker`
  Expected: all green.
  `git commit -m "chore(names): merge-persons script; US Senate same-name proof"`
