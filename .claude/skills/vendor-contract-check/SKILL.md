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

`apps/worker/test/fixtures/assemblyai-raw.json` and `ytdlp-info.json` are hand-written (id `fixture-1`), not recorded — treat them as unverified until a recorded sibling exists.

## Digestor boundaries and what is known

| Boundary | Code | Known real behaviour | Status |
|---|---|---|---|
| AssemblyAI transcribe | `transcribe/assemblyai.ts` | silence with `language_detection` → `status:"error"`, "…no spoken audio" (docs); missing `audio_duration` possible | silence handled; no recorded fixtures yet |
| Claude structured output | `llm/structured.ts`, `agents/*` | can exceed list caps, emit odd timestamps (`1:02:03`), out-of-range labels/scores | caps + timestamps handled leniently; label/score still strict (Plan 2 backlog) |
| Claude tool calls (Ask) | `llm/tools.ts`, `agents/ask.ts` | per `@langchain/core` 1.3 types: `tool_calls[].id` optional, unparseable JSON lands in `invalid_tool_calls` with `args` as a string; tool_use needs an object `input` | adapter maps both, args validated in each tool; no recorded response yet (smoke.md §3) |
| Anthropic transport | `llm/structured.ts` | 429 rate limit, 529 overloaded, network resets — transient | retried by pg-boss; only the final attempt fails the session |
| yt-dlp | `youtube/ytdlp.ts` | bot check ("Sign in to confirm you're not a bot"), age gate, private/removed, playlists, live streams | messages mapped; no size cap or live filter yet (Plan 2 backlog) |
| ffprobe/ffmpeg | `media/ffmpeg.ts` | zero-byte or non-video file → probe fails; no audio stream | friendly failures; tested with real ffprobe in the container |

Update this table when you learn something real — it is the project's memory of vendor behaviour.

## Reporting

In your report, state for each fake you touched: which cases are backed by a recording, which by docs (with URL), and which are unverified guesses. Unverified cases go into `scripts/smoke.md` so the next real-key run checks them.
