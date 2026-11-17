---
name: nextjs16-gotchas
description: Version-pinned pitfalls of Next.js 16 (App Router, Cache Components, Turbopack, middleware, standalone output) as used in Digestor's web app, with the patterns that fixed them. Read this before adding or changing a page, layout, route handler, middleware/password gate, upload or file-serving route, SSE stream, server/client component boundary, next.config, or the web Dockerfile — and when debugging "works in dev, broken in build", truncated uploads, pages stuck on the loading fallback, unexpected 200s, or imports that fail only under Turbopack. Use it for Plan 2 web work too (copilot chat route, heat timeline UI).
---

# Next.js 16: what bit us

Verified against `next` 16.4 with React 19.3 (`apps/web/package.json`). If the lockfile shows a newer major, re-check items against the Next docs/release notes before relying on them.

Architecture reminder: the web app only reads/writes Postgres and **enqueues** jobs (send-only pg-boss). All LLM, transcription, ffmpeg and yt-dlp work runs in the worker. Keep it that way — a route handler that calls Claude or ffmpeg will block a request for minutes and doesn't survive restarts.

## Middleware and the password gate

1. **Middleware runs on the Edge runtime: no Node `crypto`, `fs`, `pg`.** The HMAC cookie uses Web Crypto (`crypto.subtle`) in `lib/auth.ts`, which works in both middleware and Node route handlers. Don't import anything server-only into `middleware.ts`.
2. **When middleware runs on a request, Next buffers the body in memory and truncates it past 10 MB.** Streamed multi-GB uploads break silently. The upload route is excluded from the matcher and **checks the gate itself** (`isAuthorized(authCookieFrom(req))` at the top of `PUT`). Any new large-body route needs the same: exclude it and gate it in the handler.
3. **Anchor matcher exclusions** (`api/sessions/upload$`). An unanchored exclusion also skips the gate for every future route under that prefix. Test both the excluded path and a sibling path (`middleware.test.ts`).
4. **Pages redirect to `/login`, API routes answer 401 JSON** — keep that split for new routes.
5. Next 16 deprecates `middleware.ts` in favour of `proxy.ts` (dev prints a warning). Renaming is a separate, deliberate change — re-test the gate and the upload exclusion if you do it.

## Cache Components and rendering

6. **`cacheComponents: true` means dynamic data must sit inside `<Suspense>`.** A page that reads the DB per request is a sync shell that renders an async child inside `Suspense` (`app/s/[id]/page.tsx`: `SessionPage` → `<Suspense fallback={<AppBar />}><SessionScreen/></Suspense>`). Reading the DB at the top level of the page fails the build or turns it static.
7. **`notFound()` under Cache Components returns HTTP 200** with the not-found UI (the shell already streamed). Acceptable for pages behind the gate; **API routes must return real status codes** (`errorResponse(404, …)`), and tests must assert on API status, not page status.
8. **The first paint is the Suspense fallback.** Anything that screenshots or tests the real page must wait for the content (`<main>`), not `networkidle` — and the Processing screen keeps an SSE connection open, so `networkidle` never settles there anyway (the `digestor-run` driver handles this).
9. `params` is a Promise in pages and route handlers (`const { id } = await params`). Validate ids (`isUuid`) before touching the DB.
10. Use the generated `PageProps<"/s/[id]">` types; `pnpm --filter @digestor/web typecheck` runs `next typegen` first, so new routes need it to typecheck.

## Server/client boundary

11. **`@digestor/core` is client-safe; `@digestor/core/server` (pg, fs, Drizzle, storage) must never reach a `"use client"` file.** Client components get plain data as props from a server component or fetch it from an API route. If a client bundle suddenly needs `pg` or `fs`, an import crossed the line.
12. Interactive components (`Inbox`, `ContextCheck`, `UploadForm`, `ExportList`, …) are `"use client"`; pages are server components that load data and pass it down.
13. **Uploads use `XMLHttpRequest`, not `fetch`**: `fetch` has no upload progress events. The body is the raw file (`PUT ?filename=`), not multipart, so the route can stream it to disk without parsing.

## Route handlers that stream

14. **SSE** (`api/sessions/[id]/events`): return `new Response(readableStream)` with `text/event-stream`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` (stops proxies buffering), and stop work on `request.signal` abort. Terminal stages end the stream.
15. **File serving with Range** (`api/files/[id]/[...file]`): Safari won't play and scrubbing breaks without `206 Partial Content`; support suffix and open-ended ranges and answer 416 with `Content-Range: bytes */size`. Build the `ReadableStream` yourself with a `cancel()` that closes the file — `Readable.toWeb` throws "Controller is already closed" when the client aborts a seek.
16. **Catch-all segments for nested keys**: a single `[file]` segment can't carry `thumbs/<id>.jpg` without an encoded slash; use `[...file]` and validate the joined path against an allow-list *after* decoding.
17. `Content-Disposition` with non-ASCII titles needs `filename*=UTF-8''…` (done: `contentDisposition` in `lib/subtitleFiles.ts`; `safeBaseName` cuts by grapheme so the encoding never throws).

## Turbopack, config and env

18. **Workspace TS packages**: `transpilePackages: ["@digestor/core"]` and core's `exports` point at `.ts` source. Turbopack can't map `.js` → `.ts`, so **relative imports inside `packages/core` use `.ts` extensions** (`allowImportingTsExtensions`); the worker keeps `.js`.
19. `serverExternalPackages: ["pg", "pg-boss"]` — don't let Next bundle them.
20. **Runtime file lookups need `/*turbopackIgnore: true*/`** in `path.*` calls (see `lib/env.ts`), or Next traces the whole repo into the build.
21. **Env on the host comes from the repo-root `.env`**, loaded by `loadRootEnv()` (next.config and lazily in `lib/server.ts`); in containers compose provides env and there is no file. `DATA_DIR` resolves against the repo root, not `apps/web`. `agentRules: false` stops `next dev` writing an `AGENTS.md` into the repo.
22. **DB pool and pg-boss sender are singletons on `globalThis`** (`lib/server.ts`) so dev hot reloads don't leak connections. The web's pg-boss is send-only (`supervise: false, schedule: false`) — the worker owns maintenance and cron.

## Production build

23. `output: "standalone"` → the image copies `.next/standalone`, `.next/static` and `public/` (create an empty `public/` if it's untracked) and runs `node apps/web/server.js` with `HOSTNAME=0.0.0.0`. Next takes the trace root from the lockfile; `pg`/`pg-boss` must appear in `.next/standalone/node_modules`.
24. `.dockerignore` patterns at the root don't match nested `apps/web/.next` — use `**/.next` so a local dev cache isn't sent into the build context.

## Testing

- Route handlers are tested by importing the handler and calling it with a real `Request` (`import { PUT } from "./route"`), against the real test DB via `createHarness()` (`test/harness.ts`), which injects a temp storage and a stub sender through `setServerForTests`.
- `pnpm --filter @digestor/web test` runs on the host (needs postgres from `docker compose up -d`).
- For anything visual or interactive, use the `digestor-run` skill and look at the screenshots.
