import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChecksOutput } from "../agents/checks.js";
import { fakeFetch } from "./fakeFetch.js";
import { createOpenRouterLLM } from "./openrouter.js";
import { createAnthropicLLM } from "./structured.js";
import { UsageMeter, usageOf, withUsageMeter } from "./usage.js";

// OpenRouter reply shape as seen live on 2026-11-10 (Jev Router answered by openai/gpt-6-luna): `model` is the served
// model, `usage.cost` the charged US$, `completion_tokens_details.reasoning_tokens` the thinking tokens.
function orReply(content: string, model: string, usage: Record<string, unknown>) {
  return {
    id: "gen-1",
    object: "chat.completion",
    created: 1762790000,
    model,
    provider: "OpenAI",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { total_tokens: 0, ...usage },
  };
}

const anthropicReply = (text: string, usage: { input_tokens: number; output_tokens: number }) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage,
});

const FIXTURES = path.join(import.meta.dirname, "../../test/fixtures/openrouter");
const Label = z.object({ label: z.string() });
const MODELS = { reasoning: "typesafe/jev-router", fast: "typesafe/jev-router" };
const call = { schema: Label, name: "label", system: "Classify.", user: "I love this.", model: "fast" as const };

describe("UsageMeter", () => {
  it("adds calls per model and counts unpriced calls without guessing their cost", () => {
    const m = new UsageMeter();
    m.add("a", { inputTokens: 100, outputTokens: 10, reasoningTokens: 4, costUsd: 0.001 });
    m.add("a", { inputTokens: 50, outputTokens: 5, reasoningTokens: 0, costUsd: 0.0005 });
    m.add("b", { inputTokens: 7, outputTokens: 1, reasoningTokens: 0, costUsd: null });
    expect(m.report()).toEqual({
      a: { calls: 2, inputTokens: 150, outputTokens: 15, reasoningTokens: 4, costUsd: 0.0015, unpricedCalls: 0 },
      b: { calls: 1, inputTokens: 7, outputTokens: 1, reasoningTokens: 0, costUsd: 0, unpricedCalls: 1 },
    });
  });
});

describe("usageOf", () => {
  it("takes the served model and charged cost of an OpenRouter reply", () => {
    const msg = {
      usage_metadata: { input_tokens: 41, output_tokens: 12, output_token_details: { reasoning: 3 } },
      response_metadata: { model_name: "openai/gpt-6-luna", usage: { prompt_tokens: 41, completion_tokens: 12, cost: 1.01e-5 } },
    };
    expect(usageOf(msg, "typesafe/jev-router")).toEqual({ model: "openai/gpt-6-luna", inputTokens: 41, outputTokens: 12, reasoningTokens: 3, costUsd: 1.01e-5 });
  });

  it("prices an Anthropic reply from its tokens, and leaves an unknown model unpriced", () => {
    const msg = { usage_metadata: { input_tokens: 1_000_000, output_tokens: 100_000 }, response_metadata: { model: "claude-haiku-5-5" } };
    expect(usageOf(msg, "claude-haiku-5-5").costUsd).toBeCloseTo(0.1 + 0.05, 10);
    expect(usageOf({ usage_metadata: { input_tokens: 5, output_tokens: 5 } }, "someone/else").costUsd).toBeNull();
  });
});

describe("metering real adapter calls", () => {
  it("OpenRouter: records the routed model, tokens and cost of a call made inside a meter", async () => {
    const { fetch } = fakeFetch([
      { body: orReply('{"label":"positive"}', "openai/gpt-6-luna", { prompt_tokens: 41, completion_tokens: 12, cost: 1.01e-5, completion_tokens_details: { reasoning_tokens: 2 } }) },
    ]);
    const llm = createOpenRouterLLM("sk-or-test", MODELS, { fetch });
    const meter = new UsageMeter();

    const out = await withUsageMeter(meter, () => llm.generate(call));

    expect(out).toEqual({ label: "positive" });
    expect(meter.report()).toEqual({ "openai/gpt-6-luna": { calls: 1, inputTokens: 41, outputTokens: 12, reasoningTokens: 2, costUsd: 1.01e-5, unpricedCalls: 0 } });
  });

  it("OpenRouter: a reply that fails the schema is paid too, so the retry counts as a second call", async () => {
    const { fetch } = fakeFetch([
      { body: orReply('{"nope":1}', "openai/gpt-6-luna", { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 }) },
      { body: orReply('{"label":"ok"}', "openai/gpt-6-luna", { prompt_tokens: 10, completion_tokens: 3, cost: 0.002 }) },
    ]);
    const llm = createOpenRouterLLM("sk-or-test", MODELS, { fetch });
    const meter = new UsageMeter();
    await withUsageMeter(meter, () => llm.generate(call));
    expect(meter.report()["openai/gpt-6-luna"]).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 5, costUsd: 0.003 });
  });

  it("keeps two concurrent runs apart and records nothing outside a meter", async () => {
    const replies = [1, 2, 3].map((i) => ({ body: orReply('{"label":"x"}', "m", { prompt_tokens: i, completion_tokens: 0, cost: i / 1000 }) }));
    const { fetch } = fakeFetch(replies);
    const llm = createOpenRouterLLM("sk-or-test", MODELS, { fetch });
    const a = new UsageMeter();
    const b = new UsageMeter();
    await Promise.all([withUsageMeter(a, () => llm.generate(call)), withUsageMeter(b, () => llm.generate(call))]);
    await llm.generate(call); // outside any meter
    expect(a.report().m!.calls + b.report().m!.calls).toBe(2);
    expect(a.report().m!.calls).toBe(1);
    expect(a.report().m!.costUsd + b.report().m!.costUsd).toBeCloseTo(0.003, 10);
  });

  // Real replies to the checks schema from the 7 models of the 2026-11-10 comparison (scripts/probe-schemas.ts --record).
  const recorded = readdirSync(FIXTURES).filter((f) => /^usage-.*\.recorded\.json$/.test(f));
  it.each(recorded)("recorded %s: parses with the real checks schema and meters the served model and charged cost", async (file) => {
    const { response } = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as { response: { model: string; usage: { cost: number; prompt_tokens: number; completion_tokens: number } } };
    const { fetch } = fakeFetch([{ body: response }]);
    const requested = file.replace(/^usage-/, "").replace(/\.recorded\.json$/, "").replace("_", "/");
    const llm = createOpenRouterLLM("sk-or-test", { reasoning: requested, fast: requested }, { fetch });
    const meter = new UsageMeter();
    await withUsageMeter(meter, () => llm.generate({ schema: ChecksOutput, name: "checks", system: "s", user: "u", model: "fast" }));
    expect(meter.report()).toEqual({
      [response.model]: expect.objectContaining({ calls: 1, inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens, costUsd: response.usage.cost, unpricedCalls: 0 }),
    });
  });

  it("Anthropic: prices the call from the reply's tokens", async () => {
    const { fetch } = fakeFetch([{ body: anthropicReply('{"label":"positive"}', { input_tokens: 2000, output_tokens: 100 }) }]);
    const llm = createAnthropicLLM("sk-ant-test", { fetch });
    const meter = new UsageMeter();
    await withUsageMeter(meter, () => llm.generate(call));
    const u = meter.report()["claude-haiku-5-5"]!;
    expect(u).toMatchObject({ calls: 1, inputTokens: 2000, outputTokens: 100, unpricedCalls: 0 });
    expect(u.costUsd).toBeCloseTo((2000 * 0.1 + 100 * 0.5) / 1e6, 10);
  });
});
