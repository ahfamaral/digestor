# 360p Preview + audio.mp3 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New preview copies (`proxy.mp4`) are 360p with mono 64 kb/s voice audio, and `audio.mp3` is deleted once a session is `ready`.

**Architecture:** `makeProxy` changes its ffmpeg arguments. A worker helper `releaseAudio` deletes `audio.mp3` and clears `sessions.audio_key` for a `ready` session; it runs right after the `settlePreview` calls that can make a session ready, and the daily `maintenance.cleanup` job sweeps any `ready` session that still has audio (this also cleans the four existing sessions).

**Tech Stack:** TypeScript (ESM, strict), ffmpeg (worker container only), Drizzle/Postgres, vitest.

**Spec:** agreed in chat on 2026-11-06 (owner approved with "banana"); test evidence: 360p keeps Bundestag name captions and the US House vote tally readable; 25 fps saved nothing; audio was ~1/3 of the proxy.

## Global Constraints

- Video preview: `scale` to height **360** (never upscale: a source at or below 360 px keeps its height; height stays even), `libx264 -crf 28 -preset veryfast -pix_fmt yuv420p`, frame rate unchanged, `-movflags +faststart`.
- Preview audio (video and audio-only sources): AAC, **mono (`-ac 1`), 64 kb/s**.
- Existing previews are NOT re-encoded (owner's call). Only their `audio.mp3` goes.
- `audio.mp3` is deleted only when `stage === "ready"`; failed or in-progress sessions keep it (a retry may need to transcribe). Retention (`removeVideoFiles`) stays as is.
- Deleting audio is best effort: a failure is logged and never fails the job that called it.
- ffmpeg never runs on the host: worker tests run with `pnpm test:worker` or `docker compose run --rm worker pnpm --filter @digestor/worker test <pattern>`.
- Core relative imports use `.ts`; worker imports use `.js`.

## Review Focus

1. A session that ends `failed` (preview failed, sweep) keeps `audio.mp3` — tested in Task 2 (`releaseAudio` returns false for non-ready stages).
2. `releaseAudio` called twice (proxy job and analysis both closing the join, or the daily sweep after) is a no-op the second time — tested in Task 2.
3. `audio.mp3` already missing on disk while `audio_key` is set (deleted by hand) still clears the key — tested in Task 2.
4. A low-resolution original (e.g. 320x180) is not upscaled — tested in Task 1.
5. A ready legacy session (`proxy_status` null, `proxy_key` set) is covered by the daily sweep — tested in Task 2 (`listSessionsWithAudioToRelease` uses only stage + audio_key).

---

### Task 1: 360p mono preview copy

**Files:**
- Modify: `apps/worker/src/media/ffmpeg.ts:94-104` (`makeProxy`)
- Test: `apps/worker/src/media/ffmpeg.test.ts:76-90`
- Modify wording "480p" → "360p": `apps/worker/src/pipeline/proxy.ts:8`, `apps/worker/src/pipeline/graph.ts:250`, `packages/core/src/queue.ts:64`, `apps/web/components/ContextCheck.tsx:71`, `apps/web/components/Names/WhosWho.tsx:84`, `apps/web/lib/media.ts:2`, `CLAUDE.md` (two mentions of "480p preview copy")

**Interfaces:** `makeProxy(input: string, output: string, opts?: { hasVideo?: boolean })` — signature unchanged.

- [ ] **Step 1: Replace the 480p test with these tests** (sources generated in the test with lavfi into `outDir`):

```ts
it("makes a 360p proxy with mono audio from a 480p source", async () => {
  const src = join(outDir, "src480.mp4");
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-filter_complex", "[1]pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]", "-t", "2", "-c:v", "libx264", "-c:a", "aac", src]);
  const out = join(outDir, "proxy.mp4");
  await makeProxy(src, out);
  const p = await probe(out);
  expect([p.width, p.height]).toEqual([640, 360]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", out]);
  expect(stdout.trim()).toBe("1");
});

it("never upscales a small source", async () => {
  const src = join(outDir, "src180.mp4");
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine", "-t", "2", "-c:v", "libx264", "-c:a", "aac", src]);
  const out = join(outDir, "proxy-small.mp4");
  await makeProxy(src, out);
  expect((await probe(out)).height).toBe(180);
});
```

and in the existing audio-only test add a channels check: `expect(stdout.trim()).toBe("1")` (same ffprobe call as above).

- [ ] **Step 2: Run and see them fail**
Run: `docker compose run --rm worker pnpm --filter @digestor/worker test ffmpeg`
Expected: FAIL (height 480, 2 channels).

- [ ] **Step 3: Change `makeProxy`** — video filter `scale=-2:'trunc(min(360,ih)/2)*2'` (single argv element, no shell); both branches use `-ac 1 -b:a 64k`. Update its doc comment to "360p".

- [ ] **Step 4: Run tests** — same command; Expected: PASS.

- [ ] **Step 5: Update the "480p" wording** in the files listed above (comments and `CLAUDE.md` only; no copy shown to users mentions a resolution — verify with `grep -rn "480p" apps packages CLAUDE.md --include='*.ts' --include='*.tsx' --include='*.md'` returning only `seed-demo.ts`'s test source).

- [ ] **Step 6: Commit**
```bash
git add apps/worker/src/media/ffmpeg.ts apps/worker/src/media/ffmpeg.test.ts apps/worker/src/pipeline/proxy.ts apps/worker/src/pipeline/graph.ts packages/core/src/queue.ts apps/web/components/ContextCheck.tsx apps/web/components/Names/WhosWho.tsx apps/web/lib/media.ts CLAUDE.md
git commit -m "feat(preview): 360p preview copy with mono 64k voice audio"
```

### Task 2: Release audio.mp3 once the session is ready

**Files:**
- Modify: `packages/core/src/storage.ts` (add `removeAudio`), test `packages/core/src/storage.test.ts`
- Modify: `packages/core/src/db/repo.ts` (add `listSessionsWithAudioToRelease`), test `packages/core/src/db/repo.test.ts`
- Create: `apps/worker/src/pipeline/audio.ts` (`releaseAudio`, `releaseReadyAudio`), test `apps/worker/src/pipeline/audio.test.ts`
- Modify: `apps/worker/src/pipeline/proxy.ts:27`, `apps/worker/src/pipeline/analysis.ts:172`, `apps/worker/src/pipeline/graph.ts:381` (call `releaseAudio` after `settlePreview`)
- Modify: `apps/worker/src/main.ts:142-146` (daily cleanup also runs `releaseReadyAudio`)

**Interfaces:**
- `LocalStorage.removeAudio(sessionId: string): Promise<void>` — `rm <root>/<id>/audio.mp3` with `force: true`; `assertSafe(sessionId, false)` like `removeVideoFiles`.
- `listSessionsWithAudioToRelease(db: Db): Promise<Session[]>` — `stage = 'ready' and audio_key is not null`; exported from `@digestor/core/server`.
- `releaseAudio(deps: { db: Db; storage: Pick<LocalStorage, "removeAudio"> }, sessionId: string): Promise<boolean>` — re-reads the session; returns false unless `stage === "ready"` and `audioKey` is set; else `removeAudio`, then `updateSession(..., { audioKey: null })`, returns true. Never throws: errors are logged (`[audio] could not release audio.mp3 of <id>`) and return false.
- `releaseReadyAudio(deps: same): Promise<{ released: number }>` — `releaseAudio` for each row of `listSessionsWithAudioToRelease`.

- [ ] **Step 1: Core tests** (DB tests use `TEST_DATABASE_URL` like `repo.test.ts`):
  - `storage.test.ts`: `removeAudio deletes only audio.mp3` — folder with `audio.mp3`, `proxy.mp4`, `original.mp4`; after the call only `audio.mp3` is gone; calling again (file missing) resolves.
  - `repo.test.ts`: `listSessionsWithAudioToRelease returns ready sessions with an audio key` — sessions: ready+audioKey (listed), ready+null audioKey, failed+audioKey, preparing_preview+audioKey (not listed).

- [ ] **Step 2: Run, see them fail** — `pnpm --filter @digestor/core test storage repo` → FAIL (not a function).

- [ ] **Step 3: Implement** `removeAudio` and `listSessionsWithAudioToRelease`; export the latter from the server entry.

- [ ] **Step 4: Run** — same command → PASS.

- [ ] **Step 5: Worker tests** in `apps/worker/src/pipeline/audio.test.ts` (real DB + temp `LocalStorage`, pattern of `cleanup.test.ts`):
  - `releases audio of a ready session` — file gone, `audioKey` null, returns true; `proxy.mp4` still there.
  - `keeps audio of a session that is not ready` — stages `failed`, `preparing_preview`, `transcribing`: returns false, file and key kept.
  - `is a no-op the second time` — second call returns false.
  - `clears the key when the file is already gone` — returns true, key null.
  - `never throws` — storage whose `removeAudio` rejects: returns false, key kept.
  - `releaseReadyAudio releases every ready session with audio` — two ready + one failed → `{ released: 2 }`, failed one keeps its file.
  - In the existing proxy/analysis tests that reach `ready` (`jobs.test.ts` handleProxy success, `analysis.test.ts` initial run with the preview already done): assert `audioKey` is null afterwards when the session had one.

- [ ] **Step 6: Run, see them fail** — `docker compose run --rm worker pnpm --filter @digestor/worker test audio jobs analysis` → FAIL.

- [ ] **Step 7: Implement** `audio.ts`; call `releaseAudio({ db, storage }, sessionId)` after `settlePreview` at `proxy.ts:27` (only when `finishProxy` succeeded), `analysis.ts:172` (only `initial`), `graph.ts:381`; in `main.ts` cleanup handler call `releaseReadyAudio({ db, storage })` before retention and log `cleanup: released audio.mp3 of N ready session(s)`.

- [ ] **Step 8: Run all** — `pnpm test`, `pnpm test:worker`, `pnpm typecheck` → all green.

- [ ] **Step 9: Commit**
```bash
git add packages/core/src/storage.ts packages/core/src/storage.test.ts packages/core/src/db/repo.ts packages/core/src/db/repo.test.ts apps/worker/src/pipeline/audio.ts apps/worker/src/pipeline/audio.test.ts apps/worker/src/pipeline/proxy.ts apps/worker/src/pipeline/analysis.ts apps/worker/src/pipeline/graph.ts apps/worker/src/main.ts apps/worker/src/jobs.test.ts apps/worker/src/pipeline/analysis.test.ts
git commit -m "feat(storage): delete audio.mp3 once a session is ready"
```

### Task 3: Release the existing sessions' audio (manual, after merge)

- [ ] `docker compose restart worker`, then run once: `docker compose exec worker pnpm --filter @digestor/worker exec tsx -e "<call releaseReadyAudio with the worker's db and storage>"` (or trigger `maintenance.cleanup`); expected log/output: 4 sessions released (~245 MB). Check `ls data/*/audio.mp3` → none; open one session's Context check / Who's who and confirm a voice sample plays (from the preview).
