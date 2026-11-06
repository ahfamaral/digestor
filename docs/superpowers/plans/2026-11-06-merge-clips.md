# Merge Overlapping Clips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Prepare, two clips that overlap or touch can be merged into one clip (with a confirm first); Undo brings both originals back; the merged clip counts as approved only while every moment it covers is approved.

**Architecture:** The earlier clip survives and grows to cover both ranges; the later clip is soft-deleted (`deletedAt`), as a normal delete is. The survivor remembers the moments it absorbed in a new column `clips.merged_moment_ids` and gets one `merge` clip event whose `before` holds what Undo restores. Everything a bounds change does today (render/burns stale, tracks outdated, `warningsAck` reset) runs for the merge too.

**Tech Stack:** TypeScript strict ESM, Drizzle (Postgres), Next.js 16 route handlers and client components, vitest.

**Spec:** the design agreed in chat on 2026-11-06 (no design doc — owner chose a small change). Summary, verbatim decisions:
- Button between two clips in Prepare whose ranges overlap **or touch**; confirm dialog first (owner rule: one-click data changes ask first).
- Result: one clip from the earlier start to the later end; keeps the **earlier** clip's settings (format, crop, subtitle style/position, credit, acks); remembers both moments.
- Subtitle tracks become outdated (rebuild), a made video goes stale, checks no longer describe the clip → acknowledge warnings, exactly as after a trim.
- Undo on the merged clip brings back both originals exactly as they were (the later clip with its tracks and made files).
- "Approval dismissed" shows when **any** of the merged clip's moments is not approved; approving it again clears it. "Prepare clips" on the Briefing never recreates the absorbed clip.
- Not now: Detach (split back after later edits), merging 3+ at once, merging clips with a gap, any merge marker on the Briefing.

## Global Constraints

- `@digestor/core` relative imports use `.ts`; `@digestor/core/server` holds DB code; never import `/server` in a client component.
- Concurrency in the DB: `mergeClips` runs under `pg_advisory_xact_lock(hashtext(sessionId))` (same lock as `confirmClips`) and `select … for update` on both clips.
- User-facing errors are friendly sentences (copy below, verbatim); raw errors go to logs.
- Once the session's video is removed (`videoDeletedAt`), merge answers 409 `VIDEO_REMOVED` (R30), and the button is not shown.
- Copy (add to `apps/web/messages/en.ts` under `prepare`):
  - `mergeButton: "Merge clips {a} and {b}"`
  - `mergeTitle: "Merge clips {a} and {b}?"`
  - `mergeDescription: "They become one clip from {start} to {end} with clip {a}'s settings. Its subtitles need rebuilding. You can undo this."`
  - `mergeAction: "Merge"`, `merging: "Merging…"`
  - `mergedFrom: "Merged from {n} moments"`
  - API errors: `"Only clips that overlap or touch can be merged."`, `"One of these clips no longer exists. Reload the page and try again."`, `"Send the two clips to merge."`
- Merge edges are the two clips' existing edges, saved verbatim (no snapping: each edge already is a sentence boundary or a deliberate Alt cut; this follows the "untouched edge stays verbatim" rule).

## Review Focus

1. **Double click / two tabs merging the same pair** — the second request must not merge twice or lose a clip: it gets 409 "One of these clips no longer exists…". Test in Task 1 (second `mergeClips` returns `not_found`).
2. **Merge, then trim, then Undo twice** — the first Undo reverts the trim, the second the merge (both originals back, later clip's tracks back as they were). Test in Task 1.
3. **"Prepare clips" pressed again after a merge** — must not recreate the absorbed clip, and must not return the merged clip twice. Test in Task 1 (`confirmClips`).
4. **Later clip inside the earlier one** (B ⊂ A) and **clips that only touch** (A.end === B.start) — merged range is `[min start, max end]`; touching is allowed, a 1 ms gap is refused. Tests in Task 1.
5. **Merging a merged clip again** (A+B, then +C) — the second merge carries B's moment along; Approval dismissed reacts to all three moments. Tests in Task 1 (`mergedMomentIds`) and Task 2 (`approvalDismissed`).

---

### Task 1: Core — merged-moment column, `mergeClips`, Undo and Confirm

**Files:**
- Modify: `packages/core/src/db/schema.ts` (`clips` table, ~line 184)
- Create: `packages/core/drizzle/0017_*.sql` + snapshot (via `pnpm --filter @digestor/core db:generate`)
- Modify: `packages/core/src/personalTypes.ts` (`ClipEventKind`, `Clip`)
- Modify: `packages/core/src/db/personal.ts` (`confirmClips`, `undoLastEvent`, new `mergeClips`)
(`server.ts` already re-exports everything in `db/personal.ts`, so `mergeClips`/`MergeResult` need no extra export.)
- Test: `packages/core/src/db/personal.test.ts`

**Interfaces:**
- Produces:
  - Column `merged_moment_ids uuid[] not null default '{}'` → `Clip.mergedMomentIds: string[]` (moments absorbed by merges; never contains the clip's own `momentId`; no duplicates).
  - `ClipEventKind` gains `"merge"`.
  - `export type MergeResult = { ok: true; clip: Clip; absorbedId: string } | { ok: false; reason: "not_found" | "not_touching" }`
  - `export async function mergeClips(db: Db, ownerId: string, clipIds: [string, string], actor: ClipActor): Promise<MergeResult>`
  - `confirmClips` unchanged signature; now treats a moment in any live clip's `mergedMomentIds` as covered and returns each clip at most once.

- [ ] **Step 1: Schema + migration.** Add `mergedMomentIds: uuid("merged_moment_ids").array().notNull().default(sql\`'{}'::uuid[]\`)` to `clips`; add `mergedMomentIds: string[]` to the `Clip` interface (doc: "Moments absorbed by merges (not the clip's own `momentId`)"); add `"merge"` to `ClipEventKind`. Run `pnpm --filter @digestor/core db:generate`, rename the generated file to `0017_merged_clips.sql` (keep the journal tag in sync), then `pnpm db:migrate`. Expected: `migrations applied`.

- [ ] **Step 2: Write the failing tests** in `personal.test.ts` (use the file's existing session/moment helpers; ranges in ms):

```ts
describe("mergeClips", () => {
  it("keeps the earlier clip, spans both, soft-deletes the later, remembers its moment", async () => {
    // A [10_000, 30_000] moment mA, B [25_000, 40_000] moment mB
    const r = await mergeClips(db, OWNER, [b.id, a.id], "user"); // order of ids does not matter
    expect(r).toMatchObject({ ok: true, absorbedId: b.id });
    expect(r.ok && r.clip).toMatchObject({ id: a.id, startMs: 10_000, endMs: 40_000, momentId: mA, mergedMomentIds: [mB], warningsAck: false });
    expect(await getClip(db, b.id)).toBeNull();
    expect((await listClipEvents(db, a.id)).at(-1)).toMatchObject({ kind: "merge", actor: "user" });
    expect((await listClipEvents(db, b.id)).map((e) => e.kind)).toEqual(["create"]); // no event on the absorbed clip
  });
  it("allows touching clips (A.end === B.start) and refuses a 1 ms gap", …); // ok:true / { ok:false, reason:"not_touching" }
  it("a later clip inside the earlier one keeps the earlier range", …); // A [10_000,40_000] + B [20_000,30_000] → [10_000,40_000]
  it("same start: the clip created first survives", …);
  it("returns not_found for a deleted clip, another owner's or another session's clip, and on a second merge of the same pair", …);
  it("merging a merged clip again carries the absorbed moments along, without duplicates", …); // A+B then +C → mergedMomentIds [mB, mC]
  it("outdates the survivor's tracks and stales its done render", …); // track built for A's range → "outdated"; renderStatus "done" → "stale"
});

describe("undo of a merge", () => {
  it("restores both clips exactly as they were", …);
  // after undo: A has its old bounds and mergedMomentIds [], B is live again with its tracks untouched,
  // A's track built for its old range is "ready" again (unapproved), the merge event has undoneAt set
  it("merge, trim, undo, undo: the trim goes first, then the merge", …);
});

describe("confirmClips after a merge", () => {
  it("does not recreate the absorbed moment's clip and returns the merged clip once", async () => {
    const out = await confirmClips(db, OWNER, sessionId, [mA, mB].map(toWanted));
    expect(out.map((c) => c.id)).toEqual([a.id]);
    expect((await listClips(db, OWNER, sessionId)).map((c) => c.id)).toEqual([a.id]);
  });
});
```

- [ ] **Step 3: Run to see them fail.** `pnpm --filter @digestor/core test personal` → FAIL (`mergeClips` is not exported).

- [ ] **Step 4: Implement `mergeClips` in `personal.ts`.** One transaction: read the first live clip's `sessionId` (missing → `not_found`), take the session advisory lock, `lockClip` both, require both live, same `ownerId` and `sessionId` (else `not_found`). Order by `(startMs, createdAt)`: first = survivor, second = absorbed; require `first.endMs >= second.startMs` (else `not_touching`). Survivor update: `startMs = first.startMs`, `endMs = max(first.endMs, second.endMs)`, `mergedMomentIds` = dedupe(`first.mergedMomentIds` ∪ `second.momentId` (if non-null) ∪ `second.mergedMomentIds`) minus `first.momentId`, `updatedAt`. Absorbed: `deletedAt = now`, no event. Survivor event: `kind: "merge"`, `before: { startMs, endMs, mergedMomentIds }` (survivor's old values), `after: { startMs, endMs, mergedMomentIds, absorbedClipId }`. Then `afterBoundsChange(tx, survivorId, newBounds)` and `staleIfDone(tx, survivorId)`; return the fresh row.

- [ ] **Step 5: Undo branch in `undoLastEvent`.** For `ev.kind === "merge"`: set the survivor from `ev.before` (bounds and `mergedMomentIds`), set `deletedAt = null` on `ev.after.absorbedClipId`, then `staleIfDone` and `afterBoundsChange(tx, clipId, before bounds)` as the `bounds` branch does.

- [ ] **Step 6: `confirmClips`.** Build `byMoment` from each live clip's `momentId` **and** its `mergedMomentIds`; push each clip into `out` at most once (keep first-seen order).

- [ ] **Step 7: Run the tests.** `pnpm --filter @digestor/core test` → all pass (280+ existing still green). `pnpm typecheck` → clean (fix any `Clip` literal in web/worker tests that now needs `mergedMomentIds: []`).

- [ ] **Step 8: Commit** — `feat(core): merge two overlapping clips, with undo`.

---

### Task 2: Web — merge route, client call, approval rule

**Files:**
- Create: `apps/web/app/api/clips/merge/route.ts`
- Modify: `apps/web/lib/prepareApi.ts` (add `mergeClipsApi`)
- Modify: `apps/web/lib/prepareData.ts` (`approvalDismissed`, `canUndo` unchanged)
- Modify: `apps/web/app/s/[id]/prepare/page.tsx`, `apps/web/app/s/[id]/export/page.tsx` (call sites)
- Test: `apps/web/app/api/prepare.test.ts`, `apps/web/lib/prepareData.test.ts`

**Interfaces:**
- Consumes: `mergeClips`, `MergeResult` (Task 1); `readyClip`, `frozenError`, `midSentenceFor` from `@/lib/personal`.
- Produces:
  - `POST /api/clips/merge` body `{ clipIds: [uuid, uuid] }` (strict, two distinct ids) → 200 survivor clip JSON `{ ...clip, midSentence }`; 400 `"Send the two clips to merge."`; 404 `"Clip not found."` when the first id isn't a live clip; 409 `VIDEO_REMOVED` when frozen; 409 `"Only clips that overlap or touch can be merged."` (`not_touching`); 409 `"One of these clips no longer exists. Reload the page and try again."` (`not_found`).
  - `export const mergeClipsApi = (ids: [string, string]): Promise<ClipView>` in `prepareApi.ts` (uses `call`, `toClipView`).
  - `export function approvalDismissed(clip: { momentId: string | null; mergedMomentIds: string[] }, selections: Record<string, SelectionStatus>): boolean` — true when any id in `[momentId, ...mergedMomentIds]` (nulls dropped) is not `"approved"`; a clip with no moments is never dismissed.

- [ ] **Step 1: Failing tests.**
  - `prepareData.test.ts`: `approvalDismissed({ momentId: "a", mergedMomentIds: ["b"] }, { a: "approved", b: "approved" })` → false; `{ a: "approved", b: "rejected" }` → true; `{ a: "approved" }` (b undecided) → true; `{ momentId: null, mergedMomentIds: [] }` → false; `{ momentId: null, mergedMomentIds: ["b"] }, {}` → true. Update existing `approvalDismissed` tests to the new signature.
  - `prepare.test.ts` (route, with `seedReadySession` ranges `[[10_000, 30_000], [25_000, 40_000], [60_000, 70_000]]` and clips via `confirmClips`): 200 merge returns `startMs 10_000, endMs 40_000`; second identical call → 409 with the `not_found` sentence; A + C → 409 `not_touching` sentence; bad body (one id, same id twice, non-uuid) → 400; video removed (`updateSession(..., { videoDeletedAt: new Date() })`) → 409 `VIDEO_REMOVED`.
- [ ] **Step 2: Run to see them fail.** `pnpm --filter @digestor/web test prepareData prepare` → FAIL.
- [ ] **Step 3: Implement** the route (pattern of `app/api/clips/[id]/undo/route.ts`: `isUuid`, `readyClip(db, ids[0])`, `frozenError`, then `mergeClips(db, OWNER_ID, ids, "user")`, map reasons to the copy above), `mergeClipsApi`, the new `approvalDismissed` and its two call sites (`approvalDismissed(clip, selections)`).
- [ ] **Step 4: Run.** `pnpm --filter @digestor/web test` → all pass; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** — `feat(web): POST /api/clips/merge and approval over merged moments`.

---

### Task 3: Prepare UI — Merge button, confirm, "Merged from N moments"

**Files:**
- Modify: `apps/web/lib/prepareData.ts` (add `mergePairs`), `PrepareClipData` gains `mergedCount`
- Modify: `apps/web/app/s/[id]/prepare/page.tsx` (fill `mergedCount`)
- Modify: `apps/web/components/Prepare/PrepareList.tsx` (button between cards, `ConfirmDialog`, label)
- Modify: `apps/web/messages/en.ts` (copy from Global Constraints)
- Test: `apps/web/lib/prepareData.test.ts`

**Interfaces:**
- Consumes: `mergeClipsApi` (Task 2); `ConfirmDialog` (`apps/web/components/ConfirmDialog.tsx`: `onConfirm` throws to keep the dialog open with the message).
- Produces: `export function mergePairs(clips: { id: string; startMs: number; endMs: number }[]): Set<number>` — indexes `i` (in the given, start-sorted order) where clip `i` and `i + 1` can merge: `clips[i].endMs >= clips[i + 1].startMs`. `PrepareClipData.mergedCount: number` = moments the clip covers (`(momentId ? 1 : 0) + mergedMomentIds.length`).

- [ ] **Step 1: Failing test** for `mergePairs`: overlap → `{0}`; touching (end === next start) → `{0}`; 1 ms gap → `{}`; three in a chain overlapping → `{0, 1}`; single clip → `{}`.
- [ ] **Step 2: Run to see it fail**, then implement `mergePairs`; run → pass.
- [ ] **Step 3: UI.** In `PrepareList`, between card `n` and `n+1` when `mergePairs(items.map(i => i.clip)).has(n)` and not `session.videoRemoved`: a centred, quiet dashed-outline pill button `t("prepare.mergeButton", { a: n + 1, b: n + 2 })` (follow the `digestor-ui` skill for tokens/focus ring; a `<li role="none">` or a separator element so the `<ol>` stays valid). Clicking opens one `ConfirmDialog` (`mergeTitle`, `mergeDescription` with `start`/`end` from `formatTimestamp` of the merged range, `mergeAction`, `busyLabel: merging`); `onConfirm` calls `mergeClipsApi([a.id, b.id])` then `router.refresh()`; errors throw (the dialog shows them). In `ClipCard`'s header, under the title, when `item.mergedCount > 1`: `t("prepare.mergedFrom", { n: item.mergedCount })` in the muted mono style of the clip heading line. Undo needs no change (`canUndo` already counts a `merge` event; the existing `undo()` refreshes, which brings the absorbed clip back).
- [ ] **Step 4: Run.** `pnpm --filter @digestor/web test` and `pnpm typecheck` → green.
- [ ] **Step 5: See it in the app** (skill `digestor-run`). On a **fresh seeded** session (`seed-demo.ts --stage ready`, never the owner's sessions): approve two moments, Prepare clips, extend clip 1 (`PATCH {extend:"next"}` or drag) until it overlaps clip 2; screenshot the Merge button; merge (confirm dialog); screenshot one clip with "Merged from 2 moments"; Undo → two clips back; Skip one moment on the Briefing → Prepare shows "Approval dismissed" on the merged clip, Export's ready count excludes it. 1280 and 390 px; `errors.txt` empty.
- [ ] **Step 6: Commit** — `feat(web): merge overlapping clips in Prepare`.

---

## Docs (fold into Task 3's commit)

- `CLAUDE.md` "Conventions that bite": one line — "Merge (`mergeClips`) keeps the earlier clip, soft-deletes the later one and stores its moments in `clips.merged_moment_ids`; Undo restores both; a clip is dismissed when any of its moments is not approved."
- `.claude/skills/digestor-ui/SKILL.md`: the Merge pill and its copy, if the skill lists Prepare controls.
