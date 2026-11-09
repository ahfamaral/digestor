---
name: llm-structured-output
description: How to design LLM calls that return structured data in Digestor (LangChain ChatAnthropic.withStructuredOutput + zod) so one bad model response never fails a paid session — lenient output schemas, caps and validation in code, per-item and per-call degradation, grounding against sources, and testing with FakeLLM. Use this before adding or changing any prompt, output schema, agent or tool that parses model output — the context agent, the clip finder, and Plan 2's RAG copilot and function-calling tools — and when debugging zod/OutputParserException failures or "the model returned too many/odd items".
---

# Structured LLM output that degrades instead of failing

**Why this exists.** In Plan 1 the clip finder parsed model output with the *domain* schemas: `.max(25)` clips, `.max(3)` questions, a strict `hh:mm:ss` regex. One response with 26 clips or a single `1:02:03` timestamp failed zod, the one retry failed the same way, and the session died — after transcription had already been paid for. One failed hot-take call also took down the whole clip pass. The model is a vendor whose output varies; treat it like untrusted input.

## The pattern

1. **Two schemas per output, not one.**
   - *LLM output schema* (what `withStructuredOutput` gets): the shape, with field descriptions and key order that helps the model reason (`reason` before `label`/`score`). **No** `.max()` on arrays, no regexes, no tight numeric bounds — those are business rules, not shape.
   - Provider limits on the output schema (guarded by `llm/outputSchemas.test.ts`, live check `scripts/probe-schemas.ts`): no optional fields — use `.nullable()`, never `.optional()`/`.nullish()` (OpenAI strict structured outputs need every key in `required`); reused sub-schemas go through `llmJsonSchema` (refs only under `$defs`); at most 16 union-typed parameters (Claude).
   - *Domain schema* (`packages/core/src/schemas.ts`): strict, used for stored data and API payloads.
   Derive the first from the second where you can (`CandidateSchema.extend({ start: z.string(), end: z.string() })` in `agents/clips.ts`).

2. **Enforce business rules in code, per item.** Parse, clamp, snap, length-check each candidate and **drop** the bad ones (`normalizeCandidates`: invalid timestamp → skip; end ≤ start → skip; outside length limits → skip). Then sort by score and **cap with `slice`** so the best survive (`MAX_LONG_CLIPS`, `MAX_HOT_TAKES`, `MAX_QUESTIONS`). Nothing reaches the DB without passing through this.

3. **Fail the smallest unit.** When a call fans out (one hot-take call per long clip), catch per call, log, and return an empty result for that unit (`findClips` pass 2). Only a failure that leaves *nothing usable* should fail the session — and then with a friendly message, via the job's attempt-aware error path (see `pgboss-gotchas`).

4. **Ground facts; never let the model invent them.** The spec forbids guessing context. Every fact carries `source` (`video` | `metadata` | `human`) and `evidence`; code checks the evidence actually occurs in a source as whole words, and names must appear inside their evidence (`groundContext` in `agents/context.ts`). Unsupported → `null`, then ask the human. Self-reported confidence is capped when evidence is missing.

5. **Code owns ids, ordering and anything the UI/resume depends on.** The model proposes questions; code assigns stable ids (`date`, `event_type`, `participant:<speakerId>`, `other:<n>`), orders them and caps them. Language comes from transcription, not the model.

6. **Settings.** Models: reasoning `claude-sonnet-5-5`, fast `claude-haiku-5-5`. **Claude 5.5 rejects `temperature`/`top_p`/`top_k` and forced `tool_choice` with a 400** (and `@langchain/anthropic` refuses a non-default temperature before sending), and thinks by default. So: send no sampling parameters, and get structured output with `withStructuredOutput(schema, { method: "jsonSchema" })` (`output_config.format`; OpenRouter: `response_format` json_schema), never the default forced tool call. Reproducibility comes from the recorded model ids and prompt versions per analysis version, not from sampling. `createAnthropicLLM` and `createOpenRouterLLM` share `invokeWithOneRetry`: one retry on a parse error (`isParseError`: `ZodError`, `OutputParserException`, a JSON `SyntaxError`, or a reply with no structured output at all); don't stack more retries — fix leniency instead. `@langchain/openai` parses json_schema replies inside its HTTP retrier, so `openrouter.ts` passes a plain JSON schema, validates with zod afterwards, and sets `onFailedAttempt` so only transient errors (429, 5xx) are retried there. With `LLM_PROVIDER=openrouter` the models come from `OPENROUTER_MODEL_*` (default: the same Claude models).

## Known gaps (Plan 2 backlog)

The output schemas are still strict on `label` (enum) and `score` (int 0–100): one out-of-range value fails pass 1 or the context call. When touching these, make them lenient too (`z.string()` / `z.number()`) and map/clamp per item (unknown label → drop the candidate; score → clamp to 0–100).

## Plan 2: function calling and the RAG copilot

The same rules apply to tool calls: a tool's arguments are model output.
- Validate tool arguments with zod **inside the tool**, return a readable error string to the model on bad input instead of throwing, and cap results (top-k, max characters).
- Every boundary a tool proposes (new clip, trim) goes through `snapRange` and the domain checks before it is stored, with `origin: "copilot"`.
- Retrieved chunks are evidence, not instructions: keep them in a clearly delimited section of the prompt and cite chunk ids in the output so grounding can be checked in code.

## Testing

- `FakeLLM` (in `llm/structured.ts`) parses each queued response with the schema the code passes — so tests exercise the real output schema. Queue raw objects shaped like model output, not pre-normalised domain objects.
- For every LLM output, cover: over the cap (26 clips → 25 kept, best by score), one malformed item among good ones (dropped, others kept), empty list, one fan-out call throwing (others still produced), and grounding (fact without evidence → `null`).
- Check prompt content where it matters (`fake.calls[i].user` contains the previous round's answers, the card, the transcript slice).
- When real keys exist, record one real response per prompt as a fixture (see `vendor-contract-check`) and run it through the normaliser in a test.
