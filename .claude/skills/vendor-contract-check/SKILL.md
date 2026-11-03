---
name: vendor-contract-check
description: Keep test fakes honest about external services (AssemblyAI, Anthropic/Claude via LangChain, yt-dlp, ffmpeg/ffprobe, later Chroma). Use this before writing or changing a Fake*/stub/fixture for a vendor, when adding handling for a vendor error, when a test passes only because a fake returns something convenient, and whenever the user adds API keys or runs scripts/smoke.md — that is the moment to record real responses. Also use it when reviewing code whose correctness depends on what a vendor "probably" returns.
---

# Vendor contract check

**The failure this prevents.** Plan 1's no-speech handling was tested with a fake transcriber returning an empty word list. Real AssemblyAI (with `language_detection: true`) never does that for silent audio — it returns `status: "error"` with "language_detection cannot be performed on files with no spoken audio". Every test was green; the real product showed a raw vendor error and retried a paid upload twice. A fake encodes a belief about the vendor. This skill makes you check that belief before tests build on it.

## When you write or change a fake

1. **Name the boundary.** Which call, which SDK/binary version (`pnpm-lock.yaml`, worker Dockerfile pins), which options. Options change behaviour (AssemblyAI's `language_detection` is exactly what made silence an error).
2. **List the cases the code relies on**, not just the happy path: empty input, silence/no content, oversize, auth failure, rate limit/overload (Anthropic 429/529), timeout, malformed output, partial data (missing `audio_duration`), and anything the spec turns into a user-facing message.
3. **For each case, find evidence of what the vendor really returns**, in this order of trust:
   - a recorded real response (best — see below);
   - the vendor's docs/error reference (cite the URL in a comment next to the fake);
   - the SDK's type definitions in `node_modules` (shape only, not behaviour).
   If you have none of these, the fake is a guess: say so in a comment (`// UNVERIFIED: …`) and in your report, and add the case to the smoke checklist.
4. **Make the fake able to produce each real outcome** — including throwing the vendor's actual error type/message — and test the code's handling of every one. A fake that can only succeed tests nothing about failure paths.
5. **Keep mapping code separate from the SDK call** (`mapAssemblyAI(raw)`, `throwIfError(raw)`), so recorded raw responses can be fed straight into the mapper in tests.

## Recording real responses (when keys exist)

When the owner adds keys or runs `scripts/smoke.md`, record once per case and commit the fixture:

- Save the vendor's **raw** response (before mapping) to `apps/worker/test/fixtures/<vendor>/<case>.recorded.json` with a `_meta` block: date, SDK version, request options, input description. Strip secrets, signed URLs and personal data; trim word lists to a few hundred entries if huge.
- Cases worth one real call each (cheap, short inputs): normal speech (non-English, two speakers), **silence** (the no-audio-speech case), music-only, a very short clip, a file with no audio stream. For Claude: one real structured-output response per prompt (context card, long clips, hot takes) — keep them to check the schema and the normaliser against real model output.
- Make inputs inside the worker container (ffmpeg lives there), e.g. silence: `ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 20 /data/silence.mp3`.
- Add a test per recorded fixture that runs it through the real mapping/handling code.

`apps/worker/test/fixtures/assemblyai-raw.json` and `ytdlp-info.json` are hand-written (id `fixture-1`). A recorded sibling now exists for AssemblyAI: `test/fixtures/assemblyai/pt-debate.recorded.json` (2026-10-30 smoke run, Portuguese debate, trimmed). `ytdlp-info.json` is still unverified.

## Digestor boundaries and what is known

| Boundary | Code | Known real behaviour | Status |
|---|---|---|---|
| AssemblyAI transcribe | `transcribe/assemblyai.ts` | silence with `language_detection` → `status:"error"`, "…no spoken audio" (docs); missing `audio_duration` possible | silence handled; recorded: normal Portuguese speech with speaker labels (`assemblyai/pt-debate.recorded.json`); silence/music still unrecorded |
| Claude structured output | `llm/structured.ts`, `agents/*` | Claude 5.5: `temperature`/`top_p`/`top_k` and forced `tool_choice` → 400 (migration guides); adaptive thinking on by default, so replies start with `thinking` blocks; can exceed list caps, emit odd timestamps (`1:02:03`), out-of-range labels/scores | `output_config.format` via jsonSchema, no sampling params; wire tests via injected `fetch` (`structured.test.ts`); no recorded response yet; image parts: LangChain converts `image_url` data URLs to `{type:"image", source:{type:"base64"}}` (wire test + `vision-caption-anthropic.json`, **not recorded live**, in smoke.md) |
| Claude tool calls (Ask) | `llm/tools.ts`, `agents/ask.ts` | per `@langchain/core` 1.3 types: `tool_calls[].id` optional, unparseable JSON lands in `invalid_tool_calls` with `args` as a string; tool_use needs an object `input`; Claude 5.5 needs the turn's `thinking` blocks sent back unchanged (we replay `ToolStep.raw`) | adapter maps both, args validated in each tool; wire test replays thinking + tool_use; no recorded response yet (smoke.md §3) |
| OpenRouter (LLM_PROVIDER=openrouter) | `llm/openrouter.ts` | OpenAI-compatible Chat Completions; lists no `temperature` for Claude 5.5 (with `require_parameters` that means 503); 402 = out of credits, 503 = no provider meets routing; a 200 may carry `error` instead of `choices` (https://openrouter.ai/docs/api-reference/errors); `@langchain/openai` JSON-parses json_schema replies inside its retrier (6 paid retries by default, stopped by `onFailedAttempt`) | recorded 2026-10-31 (Haiku 5.5, `test/fixtures/openrouter/`: topics, Ask tool call, Ask answer) and replayed in `openrouter.test.ts`: tool-call turns have `content: null`, ids `toolu_…`, `finish_reason: "tool_calls"`; thinking comes back as `reasoning_details` (signed), which `@langchain/openai` 1.8 drops — not replayed, and OpenRouter accepted a later round with or without it (checked by hand); 200-with-`error` and 402 still from docs only; image input recorded 2026-11-03 (`test/fixtures/vision-caption-openrouter.json`, `image_url` data URL) |
| Senado open data | `records/senado.ts` | list `plenario/lista/discursos/{yyyymmdd}/{yyyymmdd}.json` has NO full text (only a 200-char `Resumo`); text is 1 call per speech at `discurso/texto-integral/{id}` and needs `Accept: text/plain` (JSON → 406, unknown id → 404); empty day = 200 with `Sessoes: null`; unknown senator = 200 without `Parlamentar`; speeches come newest-first, no per-speech time; external guests have no `CodigoParlamentar`; a day can hold several sessions (ESP + DOR) with `CodigoSessao` | recorded 2026-11-03 (`test/fixtures/senado-*.json`); 5xx/network from convention only; single-object-for-list handled but not seen live |
| Anthropic transport | `llm/structured.ts` | 429 rate limit, 529 overloaded, network resets — transient | retried by pg-boss; only the final attempt fails the session |
| yt-dlp | `youtube/ytdlp.ts` | bot check ("Sign in to confirm you're not a bot"), age gate, private/removed, playlists, live streams; 2026.10.26 needs a JS runtime for YouTube ("No supported JavaScript runtime… only deno is enabled by default", some formats missing) | messages mapped, size cap and live filter; `--js-runtimes node` (seen working 2026-10-31: "[jsc:node] Solving JS challenges"); optional `--cookies` from `YTDLP_COOKIES_FILE` (per-download copy); a cookies run past a real bot check is not verified yet |
| ffprobe/ffmpeg | `media/ffmpeg.ts` | zero-byte or non-video file → probe fails; no audio stream | friendly failures; tested with real ffprobe in the container |

Update this table when you learn something real — it is the project's memory of vendor behaviour.

## Reporting

In your report, state for each fake you touched: which cases are backed by a recording, which by docs (with URL), and which are unverified guesses. Unverified cases go into `scripts/smoke.md` so the next real-key run checks them.
