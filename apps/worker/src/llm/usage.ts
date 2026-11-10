import { AsyncLocalStorage } from "node:async_hooks";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { LLMUsage, ModelUsage } from "@digestor/core";

/**
 * Token and dollar metering of LLM calls, per run (an analysis version, an eval's checks).
 *
 * A run wraps its work in `withUsageMeter`; every structured call made inside it (any depth, any concurrency) adds its
 * reply's usage to that run's meter, keyed by the model that actually answered (a router such as Jev Router picks one
 * per request). Retried and unparseable replies are paid too, so they count. Calls outside a meter are not recorded.
 *
 * Cost: OpenRouter puts the charged dollars in `usage.cost` of each reply (seen live 2026-11-10, recorded in
 * test/fixtures/openrouter/usage-*.recorded.json); Anthropic's API returns tokens only, so its cost comes from
 * `ANTHROPIC_PRICES` (https://platform.claude.com/docs/en/about-claude/pricing). A reply with no known price counts
 * in `unpricedCalls` instead of being guessed.
 */

/** US$ per million tokens, input / output (thinking is billed as output). */
export const ANTHROPIC_PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

export class UsageMeter {
  private byModel = new Map<string, ModelUsage>();

  add(model: string, u: { inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number | null }): void {
    const m = this.byModel.get(model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, unpricedCalls: 0 };
    m.calls += 1;
    m.inputTokens += u.inputTokens;
    m.outputTokens += u.outputTokens;
    m.reasoningTokens += u.reasoningTokens;
    if (u.costUsd === null) m.unpricedCalls += 1;
    else m.costUsd += u.costUsd;
    this.byModel.set(model, m);
  }

  report(): LLMUsage {
    return Object.fromEntries([...this.byModel].map(([k, v]) => [k, { ...v, costUsd: Math.round(v.costUsd * 1e12) / 1e12 }]));
  }
}

const current = new AsyncLocalStorage<UsageMeter>();

/** Adds one reply's usage to the meter of the current run, if any (what the adapters' callbacks do; tests use it too). */
export function recordUsage(model: string, u: Parameters<UsageMeter["add"]>[1]): void {
  current.getStore()?.add(model, u);
}

/** Runs `fn` with `meter` collecting the usage of every LLM call made inside it. */
export function withUsageMeter<T>(meter: UsageMeter, fn: () => Promise<T>): Promise<T> {
  return current.run(meter, fn);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * One reply's usage from a LangChain generation. OpenRouter (`@langchain/openai` 1.8 keeps the raw `usage` and the
 * served `model` in `response_metadata`); Anthropic (`usage_metadata` tokens, `response_metadata.model`).
 */
export function usageOf(message: unknown, requested: string): { model: string; inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number | null } {
  const msg = (message ?? {}) as { usage_metadata?: Record<string, unknown>; response_metadata?: Record<string, unknown> };
  const meta = msg.response_metadata ?? {};
  const raw = (meta.usage ?? {}) as Record<string, unknown>;
  const um = msg.usage_metadata ?? {};
  const served = (typeof meta.model_name === "string" && meta.model_name) || (typeof meta.model === "string" && meta.model) || requested;
  const inputTokens = num(um.input_tokens) || num(raw.prompt_tokens) || num(raw.input_tokens);
  const outputTokens = num(um.output_tokens) || num(raw.completion_tokens) || num(raw.output_tokens);
  const reasoningTokens =
    num((um.output_token_details as Record<string, unknown> | undefined)?.reasoning) ||
    num((raw.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  let costUsd: number | null = typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : null;
  if (costUsd === null) {
    const price = ANTHROPIC_PRICES[served] ?? ANTHROPIC_PRICES[requested];
    if (price) costUsd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
  }
  return { model: served, inputTokens, outputTokens, reasoningTokens, costUsd };
}

/**
 * LangChain callbacks that add each reply to the meter of the run this call belongs to (none outside a meter).
 * The meter is read when the call starts, and the handler is awaited, so the usage is in before `generate` returns.
 */
export function usageCallbacks(requested: string): BaseCallbackHandler[] {
  const meter = current.getStore();
  if (!meter) return [];
  const handler = BaseCallbackHandler.fromMethods({
    handleLLMEnd(output: LLMResult) {
      for (const gens of output.generations) {
        const gen = gens[0] as { message?: unknown } | undefined;
        if (!gen) continue;
        const { model, ...u } = usageOf(gen.message, requested);
        meter.add(model, u);
      }
    },
  });
  handler.awaitHandlers = true;
  return [handler];
}
