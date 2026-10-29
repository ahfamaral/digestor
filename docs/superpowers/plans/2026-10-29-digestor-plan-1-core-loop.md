# Digestor — Plan 1: Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally running and single-server-deployable app where a user uploads a long video or pastes a YouTube link, the pipeline transcribes it (language auto-detected), builds a context card and asks the human for missing context, proposes a tree of clips, lets the human approve/neutral/reject and edit start/end times, and renders approved clips with burned-in subtitles for download.

**Architecture:** pnpm monorepo. `packages/core` holds pure domain logic (schemas, time/snap math, transcript text, event-type rubrics), the Drizzle DB schema + repository, local storage, and queue names. `apps/worker` is a Node process **in a Docker container** (ffmpeg with libass, yt-dlp, Noto fonts) that runs a LangGraph.js pipeline (two `interrupt()` pauses, Postgres checkpointer) driven by pg-boss jobs, calling ffmpeg, yt-dlp, AssemblyAI and Claude via LangChain. `apps/web` is a Next.js App Router app (on the host in dev, a standalone container in prod) that streams uploads to the shared data folder, accepts YouTube links, enqueues jobs, shows progress via SSE, and hosts the Context check, Review inbox and Export screens. Locally Colima runs the compose stack; in production the same compose file plus `docker-compose.prod.yml` (web + Caddy) runs on one VPS.

**Tech Stack:** Node 22+, pnpm 9+, TypeScript (strict, ESM), Next.js (App Router, latest stable from `create-next-app`), Tailwind + shadcn/ui, Drizzle ORM + `pg`, pg-boss (v10+), `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`, `@langchain/anthropic`, `zod` ^3.25 (import from `"zod"`), `assemblyai` SDK, ffmpeg/ffprobe (Debian package, in the worker image), yt-dlp (standalone binary, in the worker image), Vitest, Docker Compose via Colima (Postgres 17, ChromaDB for Plan 2, worker), Caddy 2 (prod).

**Spec:** `docs/superpowers/specs/2026-10-28-video-digestor-design.md` — visual reference: `.superpowers/brainstorm/*/content/walkthrough.html`.

**Out of scope for Plan 1 (Plan 2):** heat curve + Edit-cut timeline with trim handles, Chroma index, copilot drawer (RAG + function calling), speaker-label checkbox, evaluation script, final README/showcase. Plan 1's edit view is timestamp fields + proxy preview only.

## Global Constraints

- All code TypeScript, `"strict": true`, ESM (`"type": "module"`). Locally: `colima start --cpu 4 --memory 8`, `docker compose up -d` (postgres, chroma, worker), `pnpm --filter @digestor/web dev` on the host. Production: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` on one VPS.
- **Never install ffmpeg/yt-dlp on the host or call the host's binaries.** Anything that runs ffmpeg or yt-dlp (worker code and its tests) runs inside the worker container: `docker compose run --rm worker pnpm --filter @digestor/worker test`.
- **The DB stores storage-relative keys** (`<sessionId>/original.mp4`), never absolute paths; each process resolves keys against its own `DATA_DIR` (host: `./data`, containers: `/data`).
- Env vars (in `.env`, documented in `.env.example`): `DATABASE_URL`, `TEST_DATABASE_URL`, `DATA_DIR`, `ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY`, `APP_PASSWORD` (gate off when unset), `MAX_UPLOAD_GB` (default 5), `RETENTION_DAYS` (default 7), `PUBLIC_HOSTNAME` (prod, for Caddy). Compose overrides `DATABASE_URL`/`DATA_DIR` for containers (host `postgres`, `/data`).
- YouTube: yt-dlp format `bv*[height<=1080]+ba/b[height<=1080]`, `--merge-output-format mp4 --no-playlist --write-info-json`; no cookies, no proxies.
- Models: reasoning = `claude-sonnet-5-5`, fast = `claude-haiku-5-5`, `temperature: 0`.
- Clip labels exactly: `heated`, `key_point`, `light` (UI text: "Heated", "Key point", "Light moment").
- Clip statuses exactly: `proposed`, `approved`, `neutral`, `rejected`. Origins: `ai`, `user`, `copilot`.
- Event types exactly: `interview`, `panel`, `parliament`, `un`, `court`, `other`. Only `interview` gets few-shot examples in v1.
- Fact sources exactly: `video`, `metadata`, `human`. A fact with no supporting source is stored as `null` — never guessed.
- Context agent asks **at most 3** questions per round and at most **one follow-up round** (2 rounds total); the human can always skip.
- Cuts never start/end mid-sentence: every AI or human boundary passes through `snapRange` (pause ≥ 300 ms or sentence-ending punctuation, 150 ms pad). Hot takes must lie inside their parent.
- Long clips: target 2–12 min, accepted 60 s–20 min (min lowered to `max(30 s, duration/4)` when the video is shorter than 8 min). Hot takes: target 15–90 s, accepted 8–120 s. At most 25 long clips, 4 hot takes per long clip.
- Subtitles are in the spoken language, burned in with the ASS style font `Noto Sans` (README tells users to install Noto Sans + Noto Sans CJK); max 42 characters per line, max 2 lines per cue.
- Renders: H.264 `-crf 18 -preset veryfast`, AAC 160k, `-movflags +faststart`. Proxy: 480p H.264 `-crf 28`, AAC 96k, faststart.
- Uploaded files are stored as `original.<ext>`; user-supplied filenames never reach ffmpeg command lines. Accepted extensions: `mp4`, `mov`, `mkv`, `webm`.
- UI shell is light, card-based (walkthrough screens 1–4, 6). Keyboard in the inbox: `A` approve, `N` neutral, `R` reject, `E` edit times, `↓`/`↑` move focus.
- Download notice text on Export: "You're responsible for how you use and share downloaded clips."

## Review Focus

1. **Video with no audio track, or no speech** → session ends in `failed` with "This video has no audio track." / "No speech was detected in this video." — not a crash or an LLM call on empty text. (Task 10)
2. **YouTube link that can't be downloaded** (bot check on a server IP, private, age-restricted, removed, a playlist or a non-YouTube URL) → the session fails with a specific human message (e.g. "YouTube blocked this download from the server. Download the video yourself and upload the file instead."), never a raw yt-dlp stack trace. (Tasks 7b, 12)
3. **Invalid user times** (end ≤ start, beyond duration, malformed like `1:2:3x`) → API answers 400 with a readable message; UI shows it inline; nothing is saved. (Task 15)
4. **Seeking in the preview player** needs HTTP Range; without `206 Partial Content` Safari won't play and scrubbing breaks. (Task 12)
5. **Worker restarts mid-run** (laptop sleep, crash) → the job is retried and the graph resumes from its checkpoint; re-running `find_clips` must not duplicate clips. (Tasks 10, 11)

---

## File Structure

```
package.json · pnpm-workspace.yaml · tsconfig.base.json · vitest.workspace.ts
docker-compose.yml · docker-compose.prod.yml · Caddyfile · docker/initdb/01-test-db.sql · .env.example · .gitignore · README.md
apps/worker/Dockerfile · apps/web/Dockerfile
packages/core/src/
  schemas.ts          zod schemas + inferred types (Word, Transcript, ContextCard, Candidate, enums)
  time.ts             formatTimestamp / parseTimestamp
  snap.ts             boundaries, snapRange, fitChildInParent, overlapRatio
  transcriptText.ts   toSentences, renderTranscript, speakerShares
  eventTypes.ts       EVENT_TYPES rubric config
  cost.ts             estimateCostUsd
  storage.ts          LocalStorage
  queue.ts            QUEUES + payload schemas
  db/schema.ts        Drizzle tables
  db/client.ts        createDb
  db/repo.ts          repository functions
  index.ts            re-exports
packages/core/drizzle/               generated migrations
apps/worker/src/
  media/ffmpeg.ts     probe, extractAudio, makeProxy, thumbnail, renderClip
  media/subtitles.ts  buildCues, buildAss, buildSrt
  transcribe/assemblyai.ts  Transcriber, AssemblyAITranscriber, mapAssemblyAI
  youtube/ytdlp.ts    downloadYouTube, mapInfoJson, mapYtDlpError (parseYouTubeUrl lives in core/youtubeUrl.ts)
  cleanup.ts          retention clean-up job
  llm/structured.ts   StructuredLLM, createAnthropicLLM, FakeLLM
  agents/context.ts   buildContextPrompt, groundContext, assessSufficiency, understandContext
  agents/clips.ts     prompts, normalizeCandidates, findClips
  pipeline/graph.ts   buildPipeline
  pipeline/render.ts  renderOne
  jobs.ts             job handlers
  main.ts             wiring (pg-boss, checkpointer, deps)
  test/fixtures/      sample transcript json, assemblyai raw json; globalSetup makes test.mp4
apps/web/
  app/page.tsx                         Upload
  app/s/[id]/page.tsx                  stage router (Processing / Context / Review)
  app/s/[id]/export/page.tsx           Export
  app/api/sessions/upload/route.ts     PUT streamed upload
  app/api/sessions/youtube/route.ts    POST YouTube link
  middleware.ts · app/login/page.tsx   password gate
  app/api/sessions/[id]/events/route.ts SSE progress
  app/api/sessions/[id]/context/route.ts GET card / POST resume
  app/api/sessions/[id]/clips/route.ts GET clips
  app/api/sessions/[id]/render/route.ts POST render
  app/api/clips/[id]/route.ts          PATCH status / bounds
  app/api/files/[id]/[file]/route.ts   GET files with Range
  lib/server.ts                        db, storage, boss singletons
  lib/review.ts                        keyboard → action mapping, filters
  components/…                         Stepper, UploadForm, ContextCheck, ClipCard, Inbox, EditTimesDialog, ExportList
```

---

### Task 1: Monorepo, local services, test harness

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `docker-compose.yml`, `docker/initdb/01-test-db.sql`, `.env.example`, `.gitignore`, `.dockerignore`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/Dockerfile`, `apps/worker/src/toolcheck.test.ts`
- Test: `packages/core/src/smoke.test.ts`, `apps/worker/src/toolcheck.test.ts`

**Interfaces:**
- Produces: workspace packages `@digestor/core` and `@digestor/worker`; root scripts `pnpm test`, `pnpm db:migrate`; compose services `postgres` (`postgres:17`, host port 5432, user/pass/db `digestor`, test DB `digestor_test`), `chroma` (`chromadb/chroma`, port 8000), `worker` (built from `apps/worker/Dockerfile`, repo bind-mounted at `/app`, `./data` at `/data`, `DATA_DIR=/data`, `DATABASE_URL` pointing at host `postgres`, command `pnpm --filter @digestor/worker dev`).
- Worker image (`node:22-bookworm-slim`): `apt-get install ffmpeg fonts-noto-core fonts-noto-cjk python3 ca-certificates`, yt-dlp standalone binary from its GitHub releases to `/usr/local/bin/yt-dlp`, `corepack enable` for pnpm. Multi-stage: `dev` target (deps only, source mounted) and `prod` target (copies source, `pnpm install --frozen-lockfile`, runs `node --import tsx apps/worker/src/main.ts`).

- [ ] **Step 1:** Host prerequisites (one-time, documented in README): `brew install docker-compose`, add `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` to `~/.docker/config.json`, `colima start --cpu 4 --memory 8`. Verify `docker compose version` prints a version.
- [ ] **Step 2:** `git init`; `.gitignore` and `.dockerignore` cover `node_modules`, `.env`, `data/`, `.superpowers/`, `.next/`, `dist/`.
- [ ] **Step 3:** Root `package.json` (`"private": true`, `"type": "module"`, `engines.node >=22`), workspace globs `apps/*`, `packages/*`; strict `tsconfig.base.json` (`module`/`moduleResolution` `NodeNext`, `target` ES2023). Vitest workspace includes `packages/*` and `apps/*`.
- [ ] **Step 4:** `docker-compose.yml` with the three services above; `01-test-db.sql`: `CREATE DATABASE digestor_test;`. The worker service uses a named volume for `/app/node_modules` so host and container modules don't clash.
- [ ] **Step 5: Write the tests** — `expect(1 + 1).toBe(2)` in core; in `toolcheck.test.ts`: `ffmpeg -hide_banner -filters` output matches `/\bass\b/`, `yt-dlp --version` exits 0, `fc-list` output contains `Noto Sans CJK`.
- [ ] **Step 6:** Run `docker compose up -d --build && pnpm install && pnpm --filter @digestor/core test && docker compose run --rm worker pnpm --filter @digestor/worker test`. Expected: all pass; `docker compose ps` shows postgres, chroma, worker running.
- [ ] **Step 7: Commit** — `chore: scaffold monorepo, compose stack and worker image with ffmpeg/yt-dlp`.

### Task 2: Domain schemas and event-type rubrics

**Files:**
- Create: `packages/core/src/schemas.ts`, `packages/core/src/eventTypes.ts`, `packages/core/src/cost.ts`
- Test: `packages/core/src/schemas.test.ts`

**Interfaces:**
- Produces (all exported with `z.infer` types of the same name without `Schema`):
  - `WordSchema = { text: string, startMs: int ≥0, endMs: int ≥0, speaker: string, confidence: number 0..1 }`
  - `TranscriptSchema = { language: string, languageConfidence: number, durationMs: int, words: Word[] }`
  - `EventTypeSchema`, `ClipLabelSchema`, `ClipStatusSchema`, `ClipOriginSchema`, `FactSourceSchema` (values per Global Constraints)
  - `FactSchema = { value: string | null, source: FactSource | null, evidence: string | null }`
  - `ParticipantSchema = { speakerId: string, name: Fact, role: Fact, affiliation: Fact }`
  - `QuestionSchema = { id: string, target: "date" | "event_type" | "participant" | "other", speakerId: string | null, question: string, why: string, sampleStartMs: number | null }`
  - `ContextCardSchema = { language: Fact, eventType: { value: EventType, confidence: number 0..1, evidence: string | null }, title: Fact, summary: string, setting: Fact, dateOrYear: Fact, participants: Participant[], sufficient: boolean, openQuestions: Question[] (max 3) }`
  - `CandidateSchema = { title: string, reason: string, label: ClipLabel, score: int 0..100, start: "hh:mm:ss", end: "hh:mm:ss", evidence: string[] }` — **key order exactly this** (reason precedes label/score so the model reasons first).
  - `ResumePayloadSchema = discriminatedUnion("action", [{ action: "continue", answers: {questionId, answer}[], cardEdits: { title?, setting?, dateOrYear?, eventType?, participants?: {speakerId, name?, role?, affiliation?}[] } }, { action: "skip" }, { action: "render" }])`
  - `EVENT_TYPES: Record<EventType, { label: string; rubric: string; speakerLabel: "name_role" | "name_party" | "name_country" | "role_only" | "name"; fewShot: string[] }>` — rubric text from spec §4 table; `fewShot` empty except `interview` (placeholder `[]` until Plan 2 labelling, then filled).
  - `estimateCostUsd(durationMs: number): number` — `USD_PER_HOUR = 0.40` (comment: verify against vendor pricing), rounded to cents.

- [ ] **Step 1: Write failing tests**

```ts
it("candidate keys keep reason before label and score", () => {
  expect(Object.keys(CandidateSchema.shape)).toEqual(
    ["title","reason","label","score","start","end","evidence"]);
});
it("context card rejects more than 3 open questions", () => {
  expect(ContextCardSchema.safeParse(cardWith4Questions).success).toBe(false);
});
it("start must be hh:mm:ss", () => {
  expect(CandidateSchema.safeParse({...validCandidate, start: "1:2:3"}).success).toBe(false);
});
it("every event type has a rubric", () => {
  for (const t of EventTypeSchema.options) expect(EVENT_TYPES[t].rubric.length).toBeGreaterThan(40);
});
it("estimates cost per hour", () => { expect(estimateCostUsd(90 * 60_000)).toBe(0.6); });
```

- [ ] **Step 2:** Run `pnpm --filter @digestor/core test` → FAIL (modules missing).
- [ ] **Step 3:** Implement the schemas, `EVENT_TYPES`, `estimateCostUsd`; re-export from `index.ts`.
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5: Commit** — `feat(core): domain schemas, event-type rubrics, cost estimate`.

### Task 3: Time parsing and boundary snapping

**Files:**
- Create: `packages/core/src/time.ts`, `packages/core/src/snap.ts`
- Test: `packages/core/src/time.test.ts`, `packages/core/src/snap.test.ts`

**Interfaces:**
- Produces:
  - `formatTimestamp(ms: number, opts?: { tenths?: boolean }): string` → `"01:05:09"` / `"01:05:09.4"`
  - `parseTimestamp(s: string): number` — accepts `hh:mm:ss`, `hh:mm:ss.s`, `mm:ss`; throws `InvalidTimestampError` otherwise (minutes/seconds must be < 60).
  - `type Boundary = { afterWordEndMs: number; beforeWordStartMs: number }`
  - `findBoundaries(words: Word[], durationMs: number, minPauseMs = 300): Boundary[]` — includes `{0, words[0].startMs}` and `{lastEnd, durationMs}`; a boundary between words i and i+1 when gap ≥ `minPauseMs` **or** word i ends with `.`, `?`, `!`, `…`, `。`, `？`, `！`.
  - `snapRange(b: Boundary[], r: { startMs: number; endMs: number }, padMs = 150): { startMs; endMs }` — start → boundary whose `beforeWordStartMs` is nearest, result `max(afterWordEndMs, beforeWordStartMs - pad)`; end → boundary whose `afterWordEndMs` is nearest, result `min(beforeWordStartMs, afterWordEndMs + pad)`; if the result collapses (end ≤ start), end moves to the next boundary.
  - `fitChildInParent(child, parent, minMs = 8000): { startMs; endMs } | null` — clamps into parent; null if shorter than `minMs`.
  - `overlapRatio(a, b): number` — intersection / shorter length.

- [ ] **Step 1: Write failing tests** (use a fixture of words: "Hello there." 0–900, gap 100, "We" 1000–1200 … with one 400 ms pause)

```ts
expect(formatTimestamp(3_909_400, { tenths: true })).toBe("01:05:09.4");
expect(parseTimestamp("01:05:09.4")).toBe(3_909_400);
expect(parseTimestamp("05:09")).toBe(309_000);
expect(() => parseTimestamp("1:2:3x")).toThrow(InvalidTimestampError);
expect(() => parseTimestamp("00:61:00")).toThrow(InvalidTimestampError);
// a time in the middle of a word snaps to the sentence start, never mid-word
const r = snapRange(findBoundaries(words, 10_000), { startMs: 1_100, endMs: 4_050 });
expect(words.some(w => r.startMs > w.startMs && r.startMs < w.endMs)).toBe(false);
expect(words.some(w => r.endMs > w.startMs && r.endMs < w.endMs)).toBe(false);
expect(fitChildInParent({ startMs: 0, endMs: 20_000 }, { startMs: 5_000, endMs: 60_000 })).toEqual({ startMs: 5_000, endMs: 20_000 });
expect(fitChildInParent({ startMs: 0, endMs: 9_000 }, { startMs: 5_000, endMs: 60_000 })).toBeNull();
expect(overlapRatio({ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 25 })).toBe(0.5);
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(core): timestamp parsing and pause/sentence snapping`.

### Task 4: Transcript text for prompts

**Files:**
- Create: `packages/core/src/transcriptText.ts`
- Test: `packages/core/src/transcriptText.test.ts`

**Interfaces:**
- Produces:
  - `type Sentence = { startMs: number; endMs: number; speaker: string; text: string }`
  - `toSentences(words: Word[]): Sentence[]` — split on sentence-ending punctuation (same set as Task 3), speaker change, or gap ≥ 1500 ms.
  - `renderTranscript(sentences: Sentence[]): string` — lines `[hh:mm:ss] A: text`.
  - `speakerShares(words: Word[]): Record<string, number>` — fraction of words per speaker.
  - `sliceWords(words: Word[], r: { startMs; endMs }): Word[]` — words overlapping the range.

- [ ] **Step 1: Write failing tests** — speaker change splits a sentence; output line is exactly `"[00:00:01] B: Nunca prometemos isso."`; shares sum to 1; `sliceWords` includes a word straddling the start.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** — `feat(core): sentence grouping and prompt transcript rendering`.

### Task 5: Database schema, repository, local storage, queue names

**Files:**
- Create: `packages/core/src/db/schema.ts`, `packages/core/src/db/client.ts`, `packages/core/src/db/repo.ts`, `packages/core/drizzle.config.ts`, `packages/core/src/storage.ts`, `packages/core/src/queue.ts`, `packages/core/test/globalSetup.ts`
- Test: `packages/core/src/db/repo.test.ts`, `packages/core/src/storage.test.ts`

**Interfaces:**
- Produces:
  - Tables: `sessions` (`id uuid pk`, `title`, `source` 'upload'|'youtube', `sourceUrl?`, `metadata jsonb` (default `{}`), `originalKey?` (null until a YouTube download finishes), `audioKey?`, `proxyKey?`, `durationMs?`, `language?`, `eventType?`, `hint?`, `stage`, `progress int`, `error?`, `createdAt`); `transcripts` (`sessionId pk/fk`, `language`, `languageConfidence`, `durationMs`, `words jsonb`); `context_cards` (`sessionId pk/fk`, `card jsonb`, `round int`, `updatedAt`); `clips` (`id uuid`, `sessionId`, `parentId?` self-fk on delete set null, `title`, `label`, `score`, `reason`, `startMs`, `endMs`, `status`, `origin`, `outOfBounds bool`, `thumbKey?`, `renderStatus` 'none'|'queued'|'rendering'|'done'|'failed'|'stale', `renderKey?`, `srtKey?`, timestamps); `clip_events` (`id serial`, `clipId`, `actor` 'ai'|'user'|'copilot', `kind` 'create'|'status'|'bounds', `before jsonb`, `after jsonb`, `at`).
  - `type Stage = "uploaded"|"downloading"|"preparing"|"transcribing"|"understanding"|"awaiting_context"|"finding_clips"|"awaiting_review"|"rendering"|"done"|"failed"`
  - `createDb(url: string): { db: Db; close(): Promise<void> }`
  - Repo (all take `db` first): `createSession(db, {title, source, sourceUrl?, originalKey?, hint}) → Session`; `listExpiredSessions(db, olderThanDays) → Session[]`; `deleteSession(db, id)` (cascades); `getSession(db, id)`; `updateSession(db, id, patch: Partial<Session>)`; `setStage(db, id, stage: Stage, progress: number, error?: string)`; `saveTranscript(db, id, t: Transcript)`; `getTranscript(db, id) → Transcript | null`; `saveContextCard(db, id, card: ContextCard, round: number)`; `getContextCard(db, id) → { card; round } | null`; `replaceAiClips(db, sessionId, tree: ProposedClip[]) → Clip[]` (deletes existing `origin='ai' AND status='proposed'` clips of the session first, then inserts parents then children, logs `create` events); `listClips(db, sessionId) → Clip[]` ordered parent score desc, children by start; `getClip(db, id)`; `setClipStatus(db, id, status, actor)`; `setClipBounds(db, id, {startMs,endMs}, actor) → Clip` (sets `renderStatus='stale'` if it was `done`; recomputes `outOfBounds` on its children); `setRenderState(db, id, patch)`.
  - `type ProposedClip = { title; reason; label; score; startMs; endMs; children: Omit<ProposedClip,"children">[] }` (export from `schemas.ts`).
  - `class LocalStorage { constructor(rootDir: string); key(sessionId: string, file: string): string; resolve(key: string): string; saveStream(sessionId: string, file: string, body: ReadableStream<Uint8Array>, maxBytes?: number): Promise<string /* key */>; removeSession(sessionId: string): Promise<void>; }` — keys look like `<sessionId>/<file>`; `resolve` returns `<root>/<key>` and creates parent folders; `file` may contain one level of subfolder (`clips/x.mp4`, `thumbs/x.jpg`) but `key`/`resolve` throw `UnsafePathError` on `..`, absolute paths, or backslashes; `saveStream` aborts, deletes the partial file and throws `UploadTooLargeError` past `maxBytes`.
  - `QUEUES = { start: "session.start", resume: "session.resume", renderClip: "clip.render" } as const`; payload schemas `StartJob {sessionId}`, `ResumeJob {sessionId, payload: ResumePayload}`, `RenderClipJob {clipId}`.

- [ ] **Step 1:** Generate migration with `drizzle-kit generate`; `globalSetup.ts` runs migrations against `TEST_DATABASE_URL` and truncates tables.
- [ ] **Step 2: Write failing tests**

```ts
it("replaceAiClips is idempotent", async () => {
  await replaceAiClips(db, s.id, tree); await replaceAiClips(db, s.id, tree);
  expect((await listClips(db, s.id)).length).toBe(3); // 1 parent + 2 children
});
it("replaceAiClips keeps clips the user already approved", async () => { /* approve one, replace, still present */ });
it("moving a parent flags children that fall outside", async () => {
  const updated = await setClipBounds(db, parent.id, { startMs: 50_000, endMs: 90_000 }, "user");
  const kids = (await listClips(db, s.id)).filter(c => c.parentId === parent.id);
  expect(kids.find(k => k.startMs < 50_000)!.outOfBounds).toBe(true);
});
it("editing a rendered clip marks render stale", async () => { /* renderStatus 'done' → 'stale' */ });
it("storage rejects traversal", () => { expect(() => storage.key(id, "../x")).toThrow(UnsafePathError); });
it("storage returns relative keys", async () => { expect(await storage.saveStream(id, "original.mp4", body)).toBe(`${id}/original.mp4`); });
it("storage aborts oversized uploads", async () => { /* maxBytes 10, body 20 bytes → UploadTooLargeError, file absent */ });
```

- [ ] **Step 3:** Run (`pnpm --filter @digestor/core test`) → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS.
- [ ] **Step 6: Commit** — `feat(core): db schema, repository, local storage, queue names`.

### Task 6: Media — ffmpeg wrappers and subtitles

**Files:**
- Create: `apps/worker/src/media/ffmpeg.ts`, `apps/worker/src/media/subtitles.ts`, `apps/worker/test/globalSetup.ts` (generates `test/tmp/test.mp4`: `ffmpeg -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=frequency=440 -t 6 …` and `test/tmp/silent.mp4` without audio via `-an`)
- Test: `apps/worker/src/media/subtitles.test.ts`, `apps/worker/src/media/ffmpeg.test.ts`

**Interfaces:**
- Produces:
  - `probe(path): Promise<{ durationMs: number; width: number; height: number; hasAudio: boolean; tags: Record<string, string> }>` (ffprobe `-of json -show_format -show_streams`; `tags` = format tags such as `title`, `creation_time`, `comment`)
  - `extractAudio(input, output): Promise<void>` — mono, 16 kHz, mp3 64k.
  - `makeProxy(input, output): Promise<void>`; `thumbnail(input, atMs, output): Promise<void>` (jpg, width 640).
  - `renderClip({ input, output, startMs, endMs, assPath }): Promise<void>` — `-ss` before `-i`, `-t` duration, `-vf ass=<escaped path>` (escape `\`, `:`, `'` per ffmpeg filter rules).
  - All run through `run(cmd: string, args: string[]): Promise<{ stdout; stderr }>` using `spawn` (no shell); non-zero exit throws `FfmpegError` including the last 20 stderr lines.
  - `type Cue = { startMs: number; endMs: number; lines: string[] }`
  - `buildCues(words: Word[], range: { startMs; endMs }): Cue[]` — times relative to `range.startMs`; break cue at sentence end, at gap ≥ 300 ms, or when adding a word would exceed 2 lines × 42 chars or 3500 ms; words without spaces (CJK) wrap by character count.
  - `buildAss(cues: Cue[], video: { width; height }): string` — style `Noto Sans`, size = round(height × 0.055), white text, black outline 2, bottom-centre, margin 6% height.
  - `buildSrt(cues: Cue[]): string`.

- [ ] **Step 1: Write failing tests**

```ts
it("cues are relative to the clip start and exclude outside words", () => {
  const cues = buildCues(words, { startMs: 10_000, endMs: 20_000 });
  expect(cues[0].startMs).toBeGreaterThanOrEqual(0);
  expect(cues.at(-1)!.endMs).toBeLessThanOrEqual(10_000);
});
it("no cue line exceeds 42 chars and no cue exceeds 2 lines", () => { /* long sentence fixture */ });
it("wraps CJK text without spaces", () => { /* 60 CJK chars → 2 lines ≤ 42 */ });
it("srt is numbered with comma millis", () => { expect(buildSrt(cues)).toMatch(/^1\n00:00:00,000 --> /); });
it("probe reports audio presence", async () => {
  expect((await probe(TEST_MP4)).hasAudio).toBe(true);
  expect((await probe(SILENT_MP4)).hasAudio).toBe(false);
});
it("renders a 2 s clip with subtitles", async () => {
  await renderClip({ input: TEST_MP4, output, startMs: 1000, endMs: 3000, assPath });
  expect(Math.abs((await probe(output)).durationMs - 2000)).toBeLessThan(150);
});
```

- [ ] **Step 2–4:** Run inside the container (`docker compose run --rm worker pnpm --filter @digestor/worker test src/media`) — FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `feat(worker): ffmpeg wrappers and subtitle cue builder`.

### Task 7: Transcription (AssemblyAI)

**Files:**
- Create: `apps/worker/src/transcribe/assemblyai.ts`, `apps/worker/test/fixtures/assemblyai-raw.json` (trimmed real-shaped response: `language_code`, `language_confidence`, `audio_duration`, `words[{text,start,end,confidence,speaker}]`)
- Test: `apps/worker/src/transcribe/assemblyai.test.ts`

**Interfaces:**
- Produces:
  - `interface Transcriber { transcribe(audioPath: string): Promise<Transcript> }`
  - `class AssemblyAITranscriber implements Transcriber` — `new AssemblyAI({ apiKey }).transcripts.transcribe({ audio: audioPath, speaker_labels: true, language_detection: true, punctuate: true, format_text: true })`; throws `TranscriptionError(message)` when `status === "error"`.
  - `mapAssemblyAI(raw): Transcript` — seconds → ms for `audio_duration`; missing `speaker` → `"?"`; missing `language_confidence` → 1.
  - `class FakeTranscriber implements Transcriber { constructor(t: Transcript) }`

- [ ] **Step 1: Write failing tests** — mapping produces `language: "pt"`, ms durations, speakers `"A"`/`"B"`, validates against `TranscriptSchema`; `"error"` status throws `TranscriptionError`.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Vendor check (manual, ~20 min):** put two samples in `./data/samples/` and run `docker compose run --rm worker pnpm --filter @digestor/worker exec tsx scripts/try-transcribe.ts /data/samples/<file>` on a 2–3 min Portuguese clip and a 2–3 min English clip. Expected: correct language codes, two speakers separated, word timings plausible. If diarisation is poor, stop and report — swapping vendor changes only this file.
- [ ] **Step 6: Commit** — `feat(worker): AssemblyAI transcriber with language detection and diarisation`.

### Task 7b: YouTube download with metadata

**Files:**
- Create: `packages/core/src/youtubeUrl.ts` (`parseYouTubeUrl`, `InvalidYouTubeUrlError` — pure, shared with web), `apps/worker/src/youtube/ytdlp.ts`, `apps/worker/test/fixtures/ytdlp-info.json` (trimmed real `--write-info-json` output)
- Test: `packages/core/src/youtubeUrl.test.ts`, `apps/worker/src/youtube/ytdlp.test.ts`

**Interfaces:**
- Consumes: `run` from `media/ffmpeg.ts` (spawn without shell).
- Produces:
  - `parseYouTubeUrl(input: string): { videoId: string; url: string }` — accepts `youtube.com/watch?v=`, `m.youtube.com`, `youtu.be/`, `/shorts/`, `/live/`; strips playlist/time params; returns canonical `https://www.youtube.com/watch?v=<id>`; throws `InvalidYouTubeUrlError("Paste a link to a single YouTube video.")` otherwise.
  - `type YouTubeMetadata = { title: string; description: string; channel: string; uploadDate: string | null /* YYYY-MM-DD */; webpageUrl: string; durationS: number | null }`
  - `mapInfoJson(info: unknown): YouTubeMetadata` — `upload_date` `"20260314"` → `"2026-03-14"`; description truncated to 4000 chars.
  - `downloadYouTube(url: string, outPathNoExt: string): Promise<{ videoPath: string; metadata: YouTubeMetadata }>` — runs yt-dlp with the Global Constraints format flags, `-o <outPathNoExt>.%(ext)s`, reads the info json.
  - `mapYtDlpError(stderr: string): string` — human messages:
    - contains `Sign in to confirm` / `not a bot` → "YouTube blocked this download from the server. Download the video yourself and upload the file instead."
    - `Private video` → "This video is private."
    - `confirm your age` / `age-restricted` → "This video is age-restricted and can't be downloaded."
    - `Video unavailable` → "This video is unavailable or was removed."
    - otherwise → "Couldn't download this video from YouTube."

- [ ] **Step 1: Write failing tests**

```ts
expect(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=42").url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
expect(parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ").videoId).toBe("dQw4w9WgXcQ");
expect(() => parseYouTubeUrl("https://www.youtube.com/playlist?list=PL123")).toThrow(InvalidYouTubeUrlError);
expect(() => parseYouTubeUrl("https://vimeo.com/123")).toThrow(InvalidYouTubeUrlError);
expect(mapInfoJson(fixture).uploadDate).toBe("2026-03-14");
expect(mapYtDlpError("ERROR: Sign in to confirm you're not a bot")).toMatch(/upload the file instead/);
```

- [ ] **Step 2–4:** Run in the container → FAIL → implement → PASS.
- [ ] **Step 5:** Manual (in the container, from your home connection): download a 2–3 min public video; expect an MP4 that `probe` reads and metadata with an upload date.
- [ ] **Step 6: Commit** — `feat(worker): YouTube download with metadata and friendly errors`.

### Task 8: Structured LLM port and the context agent

**Files:**
- Create: `apps/worker/src/llm/structured.ts`, `apps/worker/src/agents/context.ts`
- Test: `apps/worker/src/agents/context.test.ts`

**Interfaces:**
- Consumes: `ContextCardSchema`, `QuestionSchema`, `EVENT_TYPES`, `toSentences`, `renderTranscript`, `speakerShares`.
- Produces:
  - `interface StructuredLLM { generate<T>(a: { schema: z.ZodType<T>; name: string; system: string; user: string; model: "reasoning" | "fast" }): Promise<T> }`
  - `createAnthropicLLM(apiKey: string): StructuredLLM` — `new ChatAnthropic({ model, temperature: 0, maxTokens: 16000 }).withStructuredOutput(schema, { name })`; one retry when parsing fails.
  - `class FakeLLM implements StructuredLLM { constructor(responses: unknown[]); calls: {name; system; user}[] }`
  - `type ContextInput = { words: Word[]; metadata: Record<string, string>; hint: string | null; answers: { question: string; answer: string }[]; locked: Partial<ContextCard> }`
  - `buildContextPrompt(i: ContextInput): { system: string; user: string }` — system lists event types with one-line descriptions, the evidence rule ("every fact must quote the exact transcript sentence, metadata value, or human text that supports it; otherwise null"), and question rules (max 3, plain language, most important first). User = metadata block, hint, answers, rendered transcript.
  - `groundContext(card: ContextCard, i: ContextInput): ContextCard` — nulls any fact whose `evidence` (normalised: lower-case, collapsed whitespace, punctuation stripped) is not a substring of its claimed source (`video` → transcript text, `metadata` → joined metadata values, `human` → hint + answers); then overwrites with `i.locked` fields (source `human`).
  - `assessSufficiency(card: ContextCard, words: Word[]): ContextCard` — `sufficient = eventType.confidence ≥ 0.6 && dateOrYear.value !== null && every speaker with share ≥ 0.10 has name or role`; when insufficient, ensures one question per missing item (fallback texts: date → "When was this recorded or first aired?"; event type → "What kind of event is this?"; participant → "Who is Speaker {id}?" with `sampleStartMs` = that speaker's first word), LLM questions first, dedupe by `target`+`speakerId`, cap 3. When sufficient, `openQuestions = []`.
  - `understandContext(llm: StructuredLLM, i: ContextInput): Promise<ContextCard>` — `generate` (reasoning) → `groundContext` → `assessSufficiency`.

- [ ] **Step 1: Write failing tests**

```ts
it("drops a name the transcript never says", () => {
  const card = groundContext(draftWithName("Maria Silva", "video", "a ministra Maria Silva"), input);
  expect(card.participants[0].name.value).toBeNull();
});
it("keeps a quoted fact", () => { /* evidence present in transcript → kept */ });
it("human answers become human-sourced facts via locked", () => { /* locked dateOrYear 'March 2026' → source 'human' */ });
it("missing date makes context insufficient with a date question", () => {
  const c = assessSufficiency(cardWithoutDate, words);
  expect(c.sufficient).toBe(false);
  expect(c.openQuestions.some(q => q.target === "date")).toBe(true);
});
it("never more than 3 questions", () => { /* 5 missing items → 3 */ });
it("participant question carries a sample start", () => { /* speaker B first word 12_000 */ });
it("understandContext calls the reasoning model once", async () => { /* FakeLLM.calls.length === 1 */ });
```

- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** — `feat(worker): structured LLM port and grounded context agent`.

### Task 9: Clip finder (two passes)

**Files:**
- Create: `apps/worker/src/agents/clips.ts`
- Test: `apps/worker/src/agents/clips.test.ts`

**Interfaces:**
- Consumes: `StructuredLLM`, `CandidateSchema`, `EVENT_TYPES`, `findBoundaries`, `snapRange`, `fitChildInParent`, `overlapRatio`, `parseTimestamp`, `toSentences`, `renderTranscript`, `sliceWords`.
- Produces:
  - `LongClipsOutput = z.object({ clips: z.array(CandidateSchema).max(25) })`, `HotTakesOutput = z.object({ hotTakes: z.array(CandidateSchema).max(4) })`
  - `buildLongClipPrompt(a: { card: ContextCard; words: Word[]; durationMs: number }): { system; user }` — system: role, context card (as JSON), `EVENT_TYPES[card.eventType.value].rubric`, label definitions, hard rules (complete exchange; never mid-sentence; titles in `card.language.value`; 15–25 candidates; reason before label/score), few-shot when present.
  - `buildHotTakePrompt(a: { card; parent: ProposedClip; words: Word[] }): { system; user }` — transcript limited to the parent's range.
  - `normalizeCandidates(c: Candidate[], o: { durationMs; boundaries: Boundary[]; minMs; maxMs }): Omit<ProposedClip,"children">[]` — parse times (drop on `InvalidTimestampError`), clamp to `[0, durationMs]`, `snapRange`, drop outside `[minMs, maxMs]`, dedupe pairs with `overlapRatio > 0.6` keeping the higher score, sort by score desc.
  - `longClipLimits(durationMs): { minMs; maxMs }` — `{ 60_000, 1_200_000 }`, or `{ max(30_000, durationMs/4), 1_200_000 }` when `durationMs < 480_000`.
  - `findClips(llm, a: { card; transcript: Transcript }): Promise<ProposedClip[]>` — pass 1 (reasoning) → normalize; pass 2 per parent (reasoning, concurrency 4) → normalize with `{ 8_000, 120_000 }` → `fitChildInParent` (drop nulls).

- [ ] **Step 1: Write failing tests**

```ts
it("drops malformed and reversed candidates", () => { /* start "1:2" and end<start → removed */ });
it("snaps to boundaries", () => { /* result start equals a boundary-derived value */ });
it("dedupes overlapping candidates keeping higher score", () => { /* 2 → 1, score 90 kept */ });
it("relaxes the long-clip minimum for a 5-minute video", () => {
  expect(longClipLimits(300_000).minMs).toBe(75_000);
});
it("children always sit inside their parent", async () => { /* FakeLLM returns a child spilling over → clamped or dropped */ });
it("runs pass 2 once per surviving parent", async () => { /* FakeLLM.calls.length === 1 + parents */ });
it("prompt uses the detected event type rubric and context date", () => {
  const p = buildLongClipPrompt({ card: interviewCardMarch2026, words, durationMs });
  expect(p.system).toContain(EVENT_TYPES.interview.rubric);
  expect(p.system).toContain("March 2026");
});
```

- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** — `feat(worker): two-pass clip finder with normalisation and snapping`.

### Task 10: LangGraph pipeline with two human pauses

**Files:**
- Create: `apps/worker/src/pipeline/graph.ts`, `apps/worker/src/pipeline/render.ts`
- Test: `apps/worker/src/pipeline/graph.test.ts` (MemorySaver, FakeTranscriber, FakeLLM, stubbed `downloadYouTube`, real test DB, `test.mp4`; runs in the worker container)

**Interfaces:**
- Consumes: repo functions (Task 5), `LocalStorage`, media (Task 6), `Transcriber` (7), `understandContext` (8), `findClips` (9).
- Produces:
  - `type PipelineDeps = { db: Db; storage: LocalStorage; transcriber: Transcriber; llm: StructuredLLM; media: typeof import("../media/ffmpeg.js"); youtube: { downloadYouTube: typeof downloadYouTube } }`
  - `buildPipeline(deps: PipelineDeps, checkpointer: BaseCheckpointSaver)` → compiled graph. State: `{ sessionId: string; round: number; answers: {question; answer}[]; resume: ResumePayload | null }` (heavy data lives in the DB).
  - Nodes and edges: START → `download` when `source = 'youtube'` and `originalKey` is null (stage `downloading` 2; `downloadYouTube` to `<sessionId>/original`; save `originalKey`, `metadata`, and `title` from YouTube; on failure `setStage(failed, mapYtDlpError(stderr))` and END), else straight to `ingest`. `ingest` (probe; merge probe `tags` into `metadata`; no audio → `setStage(failed, "This video has no audio track.")` and END; extract audio, proxy; save `durationMs`) → `transcribe` (empty words → failed "No speech was detected in this video."; save transcript + session language) → `understand_context` (round += 1; `metadata` = session `metadata` flattened to strings (`title`, `description`, `channel`, `uploadDate`, container tags); `hint` = session hint; `locked` = human-sourced facts from the stored card; save card + session eventType) → if `sufficient` or `round ≥ 2` → `find_clips`, else `ask_context` → `ask_context` = `interrupt({ type: "context" })`; stage `awaiting_context`; on resume `skip` → `find_clips`; `continue` → apply `cardEdits` as human facts (`source: "human"`, `evidence` = the typed value), map each answer's `questionId` to that question's text from the stored card and append `{ question, answer }` to `answers` → `understand_context` → `find_clips` (`replaceAiClips`, thumbnails at each clip midpoint to `thumbs/<clipId>.jpg`) → `review` = `interrupt({ type: "review" })`, stage `awaiting_review`; resume `render` → `render` (calls `renderOne` for every approved clip) → stage `done`.
  - Every node calls `setStage` with progress: preparing 5, transcribing 20, understanding 55, finding_clips 70, rendering 90, done 100.
  - Node functions are also exported as factories (`ingestNode(deps)`, `findClipsNode(deps)`, …) so tests can call one node directly.
  - `renderOne(deps, clipId): Promise<void>` — `renderStatus` queued→rendering→done/failed; writes `clips/<clipId>.mp4`, `clips/<clipId>.srt`, temp `.ass`.

- [ ] **Step 1: Write failing tests**

```ts
it("pauses for context when the date is missing", async () => {
  await graph.invoke({ sessionId }, cfg);
  const st = await graph.getState(cfg);
  expect(st.tasks[0].interrupts[0].value).toEqual({ type: "context" });
  expect((await getSession(db, sessionId))!.stage).toBe("awaiting_context");
});
it("skip goes straight to review with clips stored", async () => { /* Command({resume:{action:"skip"}}) → interrupt review; listClips > 0 */ });
it("asks at most one follow-up round", async () => { /* FakeLLM keeps returning insufficient; after one continue → reaches review */ });
it("sufficient context never pauses for context", async () => { /* first interrupt is review */ });
it("render only renders approved clips", async () => { /* approve 1 of 3; resume render; only that clip has renderKey */ });
it("fails cleanly on a video without audio", async () => { /* silent.mp4 → stage failed with exact message; FakeLLM.calls.length === 0 */ });
it("youtube upload date answers the date question", async () => { /* session metadata uploadDate 2026-03-14, FakeLLM cites it as metadata → no context pause */ });
it("youtube download failure ends with the friendly message", async () => { /* stub downloadYouTube throws with bot-check stderr → stage failed, message mentions uploading the file */ });
it("fails cleanly when no speech is detected", async () => { /* FakeTranscriber with words: [] → stage failed "No speech was detected in this video." */ });
it("re-running find_clips does not duplicate clips", async () => { /* call findClipsNode(deps)(state) twice → same listClips count */ });
```

- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** — `feat(worker): LangGraph pipeline with context and review interrupts`.

### Task 11: Worker jobs and process wiring

**Files:**
- Create: `apps/worker/src/jobs.ts`, `apps/worker/src/main.ts`
- Test: `apps/worker/src/jobs.test.ts`

**Interfaces:**
- Consumes: `buildPipeline`, `renderOne`, `QUEUES` + payload schemas.
- Produces:
  - `handleStart(ctx, job: StartJob)` → `graph.invoke({ sessionId }, { configurable: { thread_id: sessionId } })`
  - `handleResume(ctx, job: ResumeJob)` → `graph.invoke(new Command({ resume: job.payload }), sameConfig)`
  - `handleRenderClip(ctx, job: RenderClipJob)` → `renderOne`
  - Any thrown error → `setStage(failed, error.message)` then rethrow (pg-boss retries: `retryLimit: 2`, `retryDelay: 30`).
  - `main.ts`: load `.env`; `PostgresSaver.fromConnString(DATABASE_URL)` + `setup()`; `new PgBoss(DATABASE_URL)`, `start()`, `createQueue` for each of `QUEUES`, `work` with `batchSize: 1`; renders use a separate queue so one long session never blocks re-cuts. Root `pnpm dev` runs web + worker (`tsx watch`).

- [ ] **Step 1: Write failing tests** — with a stub graph: `handleStart` passes `thread_id = sessionId`; `handleResume` passes a `Command` whose `resume` equals the payload; a throwing graph sets stage `failed` with the message and rethrows.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5:** Manual: `pnpm --filter @digestor/worker dev` starts, logs "worker ready", creates 3 queues.
- [ ] **Step 6: Commit** — `feat(worker): pg-boss job handlers and worker entrypoint`.

### Task 12: Web app shell, upload, YouTube link, password gate, files with Range

**Files:**
- Create: `apps/web` via `create-next-app` (App Router, TS, Tailwind, ESLint, no `src/`, `output: "standalone"` in `next.config`), shadcn/ui init (`button`, `card`, `input`, `textarea`, `badge`, `dialog`, `progress`, `checkbox`, `tabs`); `apps/web/lib/server.ts`, `apps/web/app/api/sessions/upload/route.ts`, `apps/web/app/api/sessions/youtube/route.ts`, `apps/web/app/api/files/[id]/[file]/route.ts`, `apps/web/middleware.ts`, `apps/web/app/login/page.tsx`, `apps/web/app/api/login/route.ts`, `apps/web/app/page.tsx`, `apps/web/components/UploadForm.tsx`, `apps/web/components/AppBar.tsx` (logo "Digestor." + step indicator)
- Test: `apps/web/app/api/files/route.test.ts`, `apps/web/app/api/sessions/upload/route.test.ts`, `apps/web/app/api/sessions/youtube/route.test.ts`, `apps/web/middleware.test.ts`

**Interfaces:**
- Consumes: `createDb`, `LocalStorage`, `createSession`, `QUEUES`, `estimateCostUsd`.
- Produces:
  - `getServer(): { db; storage; boss }` (lazy singletons; `boss` only `send`s).
  - `PUT /api/sessions/upload?filename=<name>&hint=<text>` — body = raw file stream; rejects unsupported extension with 400 `"Unsupported file type. Use MP4, MOV, MKV or WebM."`; `Content-Length` (or streamed bytes) over `MAX_UPLOAD_GB` → 413 `"This file is larger than the <n> GB limit."`; saves `original.<ext>`; creates session (title = filename without extension, stage `uploaded`); sends `session.start`; returns `{ sessionId }`.
  - `POST /api/sessions/youtube` body `{ url: string, hint?: string }` — `parseYouTubeUrl` from `@digestor/core` → 400 with its message on failure; creates session (`source 'youtube'`, `sourceUrl` canonical, title = the URL until download fills it); sends `session.start`; returns `{ sessionId }`.
  - `middleware.ts` — when `APP_PASSWORD` is set, every route except `/login`, `/api/login` and static assets requires cookie `digestor_auth` = HMAC-SHA256(`APP_PASSWORD`, "digestor") hex; pages redirect to `/login`, API routes answer 401. `POST /api/login {password}` sets the cookie (`httpOnly`, `secure` in production, `sameSite: "lax"`, 30 days) on match, else 401 `"Wrong password."`.
  - `GET /api/files/[id]/[file]?download=1` — `file` ∈ `proxy.mp4`, `thumbs/<clipId>.jpg` (URL-encoded), `clips/<clipId>.mp4|.srt`; honours `Range` with `206`, `Content-Range`, `Accept-Ranges: bytes`; `download=1` adds `Content-Disposition: attachment; filename="<clip title>.mp4"` (title sanitised to `[\w\- ]`); 404 for anything else.
  - Upload page (walkthrough screen 1): tabs **Upload a file** / **Paste a YouTube link** (URL input with inline validation message). File tab: dropzone, file row with XHR upload progress, optional hint textarea, cost/time estimate read from the file's duration in the browser (`<video>` `loadedmetadata`), "Digest this video →" → navigates to `/s/<id>`.

- [ ] **Step 1: Write failing tests**

```ts
it("serves partial content for Range requests", async () => {
  const res = await GET(new Request(url, { headers: { Range: "bytes=0-99" } }), params);
  expect(res.status).toBe(206);
  expect(res.headers.get("Content-Range")).toMatch(/^bytes 0-99\/\d+$/);
});
it("rejects path traversal in file param", async () => { /* "..%2Foriginal.mp4" → 404 */ });
it("rejects unsupported upload type", async () => { /* filename=x.exe → 400 with exact message */ });
it("upload stores original and enqueues start", async () => { /* stub boss.send called with QUEUES.start */ });
it("rejects uploads over the size cap", async () => { /* MAX_UPLOAD_GB tiny, Content-Length above → 413 with exact message */ });
it("youtube route rejects a playlist link", async () => { /* 400 "Paste a link to a single YouTube video." */ });
it("youtube route creates a youtube session and enqueues start", async () => { /* source 'youtube', canonical sourceUrl */ });
it("gate blocks API without cookie when APP_PASSWORD is set", async () => { /* 401 */ });
it("gate is off when APP_PASSWORD is unset", async () => { /* passes through */ });
```

- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5:** Manual: `pnpm --filter @digestor/web dev`, upload a 2-minute file → `data/<id>/original.mp4` exists and `docker compose logs worker` shows processing; paste a YouTube link → worker logs the download.
- [ ] **Step 6: Commit** — `feat(web): upload and YouTube intake, password gate, range file serving`.

### Task 13: Processing screen with live progress

**Files:**
- Create: `apps/web/app/api/sessions/[id]/events/route.ts`, `apps/web/app/s/[id]/page.tsx`, `apps/web/components/Processing.tsx`
- Test: `apps/web/app/api/sessions/events.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/sessions/[id]/events` — `text/event-stream`; every 1 s sends `data: {"stage","progress","error","language","eventType"}` when changed; closes after `awaiting_context`, `awaiting_review`, `done` or `failed`.
  - `/s/[id]` server component reads the session and renders by stage: `Processing` (uploaded…finding_clips, rendering), `ContextCheck` (awaiting_context, Task 14), `Inbox` (awaiting_review, done, Task 15); `failed` shows the error and a "Start over" link.
  - `Processing` (walkthrough screen 2): stages (plus "Downloading from YouTube" first for YouTube sessions) with ✓ / running / waiting icons, progress bar, detected language and event type once known; on stream close → `router.refresh()`.

- [ ] **Step 1: Write failing test** — stream emits a first event with the current stage and closes when the stage is `awaiting_review`.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5:** Manual: during a real run the stepper advances without reloading.
- [ ] **Step 6: Commit** — `feat(web): live processing screen over SSE`.

### Task 14: Context check screen

**Files:**
- Create: `apps/web/app/api/sessions/[id]/context/route.ts`, `apps/web/components/ContextCheck.tsx`
- Test: `apps/web/app/api/sessions/context.test.ts`

**Interfaces:**
- Consumes: `getContextCard`, `ResumePayloadSchema`, `QUEUES.resume`.
- Produces:
  - `GET /api/sessions/[id]/context` → `{ card, round }`.
  - `POST /api/sessions/[id]/context` — body must parse as `ResumePayloadSchema` with `action` `continue` or `skip`; 409 unless session stage is `awaiting_context`; sets stage `understanding` (continue) or `finding_clips` (skip) and sends `session.resume`.
  - `ContextCheck` (walkthrough screen 3): left card "Here's what I understood" — language, event, title/topic, setting, date, each participant — each with a source badge (`from video` / `from metadata` / `from you` / `missing`) and click-to-edit; right card with the open questions (≤ 3), each with "▶ hear 5 s" playing the proxy from `sampleStartMs`; buttons **Continue →** and **Skip — find clips anyway**.

- [ ] **Step 1: Write failing tests** — `render` action rejected with 400; POST when stage is `awaiting_review` → 409; valid `continue` enqueues resume with the payload.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5:** Manual: an interview whose date is never mentioned pauses here; answering continues to review.
- [ ] **Step 6: Commit** — `feat(web): context check screen and resume endpoint`.

### Task 15: Review inbox with keyboard triage and time editing

**Files:**
- Create: `apps/web/app/api/sessions/[id]/clips/route.ts`, `apps/web/app/api/clips/[id]/route.ts`, `apps/web/lib/review.ts`, `apps/web/components/Inbox.tsx`, `apps/web/components/ClipCard.tsx`, `apps/web/components/EditTimesDialog.tsx`, `apps/web/components/ContextBanner.tsx`
- Test: `apps/web/lib/review.test.ts`, `apps/web/app/api/clips/patch.test.ts`

**Interfaces:**
- Consumes: `listClips`, `setClipStatus`, `setClipBounds`, `getTranscript`, `findBoundaries`, `snapRange`, `parseTimestamp`.
- Produces:
  - `GET /api/sessions/[id]/clips` → `Clip[]` as a tree `{ ...parent, children: Clip[] }[]`.
  - `PATCH /api/clips/[id]` body `{ status }` **or** `{ start: string, end: string }` (timestamp strings). Bounds: parse (400 `"Use the format hh:mm:ss or hh:mm:ss.s"`), require `0 ≤ start < end ≤ durationMs` (400 `"End must be after start and within the video (hh:mm:ss)"`), then `snapRange` with the session's boundaries, then `setClipBounds(..., "user")`; returns the updated clip including snapped values.
  - `lib/review.ts`: `keyToAction(key: string): "approve" | "neutral" | "reject" | "edit" | "next" | "prev" | null`; `filterClips(tree, f: "all" | "heated" | "key_point" | "light" | "approved" | "neutral")` — `all` hides `neutral` and `rejected`.
  - Inbox (walkthrough screen 4 without the copilot drawer): context banner, filter chips with counts, 2-column card grid (thumbnail, duration, title, label chip with score, reason, nested hot takes each with their own small A/N/R controls, out-of-bounds warning), focused-card outline, keyboard handling, "Render N approved →" button in the app bar (Task 16), empty state "No moments were found in this video." when the tree is empty.
  - `EditTimesDialog`: proxy `<video>` previewing the range (`#t=start,end`), start/end inputs, inline API error, shows snapped values after save.

- [ ] **Step 1: Write failing tests**

```ts
expect(keyToAction("a")).toBe("approve"); expect(keyToAction("ArrowDown")).toBe("next"); expect(keyToAction("x")).toBeNull();
expect(filterClips(tree, "all").some(c => c.status === "neutral")).toBe(false);
it("PATCH rejects end before start", async () => { /* 400 + exact message, clip unchanged */ });
it("PATCH rejects malformed time", async () => { /* "1:2:3x" → 400 + exact message */ });
it("PATCH snaps saved bounds", async () => { /* start mid-word → returned start at boundary */ });
```

- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5:** Manual: triage 5 cards with keyboard only; edit one clip's times and see snapped values.
- [ ] **Step 6: Commit** — `feat(web): review inbox with keyboard triage and time editing`.

### Task 16: Render trigger and Export screen

**Files:**
- Create: `apps/web/app/api/sessions/[id]/render/route.ts`, `apps/web/app/s/[id]/export/page.tsx`, `apps/web/components/ExportList.tsx`
- Test: `apps/web/app/api/sessions/render.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/sessions/[id]/render` — 400 `"Approve at least one clip first."` if none approved; if stage `awaiting_review` → stage `rendering`, send `session.resume` `{ action: "render" }`; otherwise send `clip.render` for each approved clip whose `renderStatus` ∈ `none | failed | stale`. Returns `{ queued: number }`.
  - Export page (walkthrough screen 6 without the speaker-label option): approved clips with thumbnail, title, duration, kind (long clip / hot take), render status (polls `GET /clips` every 2 s while any is queued/rendering), "⬇ MP4" and ".srt" links (`/api/files/...&download=1`), "Re-render" for stale clips, and the exact responsibility notice.

- [ ] **Step 1: Write failing tests** — no approved clips → 400 with message; at `awaiting_review` → one resume job; after `done` with one stale clip → one `clip.render` job and `queued: 1`.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** — `feat(web): render trigger and export screen`.

### Task 17: End-to-end run and README

**Files:**
- Create: `README.md`, `scripts/smoke.md` (manual checklist)

- [ ] **Step 1:** README: goal, problem, how it works (the pipeline steps, the two human pauses), local setup (Colima + docker-compose plugin, `docker compose up -d --build`, `.env`, `pnpm install`, `pnpm db:migrate`, `pnpm --filter @digestor/web dev`), YouTube note (works from home connections; best-effort on servers; personal use), what's in Plan 2, placeholder for the showcase link.
- [ ] **Step 2:** Full manual run on a real 20–40 min interview in a non-English language, once from a **YouTube link** and once as an **uploaded file**, following `scripts/smoke.md`: intake → stepper → context check (answer one question) → inbox (approve 2, neutral 1, reject 1, edit one clip's times) → render → download MP4 + SRT. Expected: subtitles in the spoken language, no cut mid-sentence, rendered duration matches the snapped times within 0.2 s.
- [ ] **Step 3:** Restart the worker mid-run (Ctrl-C during transcription, start again). Expected: the job retries and the session reaches the context check or review without duplicate clips.
- [ ] **Step 4:** `pnpm test` → all green.
- [ ] **Step 5: Commit** — `docs: README and end-to-end smoke checklist`.

### Task 18: Production build, retention clean-up, single-VPS deploy

**Files:**
- Create: `apps/web/Dockerfile` (multi-stage: `pnpm install` → `next build` → `node:22-bookworm-slim` running `.next/standalone/apps/web/server.js` on port 3000), `docker-compose.prod.yml`, `Caddyfile`, `apps/worker/src/cleanup.ts`, `docs/deploy.md`
- Modify: `apps/worker/src/main.ts` (schedule clean-up), `README.md` (link to `docs/deploy.md`)
- Test: `apps/worker/src/cleanup.test.ts`

**Interfaces:**
- Consumes: `listExpiredSessions`, `deleteSession`, `LocalStorage.removeSession`.
- Produces:
  - `runCleanup(deps: { db; storage }, retentionDays: number): Promise<{ deleted: number }>` — deletes DB rows and the session's data folder for sessions older than `retentionDays`; never touches sessions whose stage is `downloading`, `preparing`, `transcribing`, `understanding`, `finding_clips` or `rendering`.
  - pg-boss queue `maintenance.cleanup` scheduled `0 3 * * *` (daily 03:00 UTC) with `RETENTION_DAYS`.
  - `docker-compose.prod.yml`: overrides `worker` to the `prod` target with no source bind mount and `restart: unless-stopped`; adds `web` (built from `apps/web/Dockerfile`, `DATA_DIR=/data`, shared data volume, env from `.env`) and `caddy` (`caddy:2`, ports 80/443, `Caddyfile`: `{$PUBLIC_HOSTNAME} { reverse_proxy web:3000 }`, volumes for certificates); removes host port exposure of postgres and chroma; a one-shot `migrate` service runs `pnpm db:migrate` before web/worker start (`depends_on: condition: service_completed_successfully`).
  - `docs/deploy.md` runbook: create a VPS (4 vCPU / 8 GB / 80+ GB disk, Ubuntu LTS), point a DNS A record at it, install Docker Engine + compose plugin, clone the repo, write `.env` (all Global Constraints vars, a strong `APP_PASSWORD`, `PUBLIC_HOSTNAME`), run `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`, how to read logs, how to update (`git pull` + same command), how to back up the Postgres volume.

- [ ] **Step 1: Write failing tests**

```ts
it("deletes sessions older than the retention window with their files", async () => { /* 8-day-old done session → row gone, folder gone; deleted === 1 */ });
it("keeps recent sessions", async () => { /* 2-day-old session untouched */ });
it("never deletes a session that is still processing", async () => { /* 30-day-old session in 'transcribing' kept */ });
```

- [ ] **Step 2–4:** Run in the container → FAIL → implement → PASS.
- [ ] **Step 5:** Local production rehearsal: set `PUBLIC_HOSTNAME=localhost` and `APP_PASSWORD` in `.env`, run the prod compose command under Colima. Expected: `https://localhost` (Caddy's local certificate) shows the login page; after logging in, a 5-minute upload goes through to download.
- [ ] **Step 6:** Deploy to the VPS following `docs/deploy.md`. Expected: `https://<PUBLIC_HOSTNAME>` serves the login page with a valid certificate; a 10-minute uploaded file completes end to end; a YouTube link either completes or fails with the "upload the file instead" message (both acceptable — note which in the README).
- [ ] **Step 7: Commit** — `feat(deploy): production images, retention clean-up, single-VPS runbook`.
