import { SystemMessage } from "@langchain/core/messages";
import { ChatOpenAICompletions } from "@langchain/openai";
import { invokeWithOneRetry, isParseError, llmJsonSchema, validated, type ClientOptions, type GenerateArgs, type LLMModel, type StructuredLLM } from "./structured.js";
import { fromAIMessage, toLangChainMessages, type ToolLLM } from "./tools.js";
import { usageCallbacks } from "./usage.js";

/** OpenAI-compatible Chat Completions API: https://openrouter.ai/docs/api-reference/overview */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** LangChain's own no-retry statuses (its default handler isn't exported). */
const NO_RETRY_STATUS = new Set([400, 401, 402, 403, 404, 405, 406, 407, 409, 413]);

/**
 * LangChain's retrier wraps the JSON parse of a json_schema reply, so by default a prose or broken reply is re-bought
 * up to 6 times with backoff. Throwing here stops that: bad replies get `invokeWithOneRetry`'s single retry, and
 * only transient failures (429, 5xx, network) are retried by LangChain.
 */
export function stopRetryingUnlessTransient(err: unknown): void {
  if (isParseError(err)) throw err;
  if (err instanceof Error && (err.name === "AbortError" || err.message.startsWith("Cancel"))) throw err;
  const e = err as { status?: unknown; response?: { status?: unknown } } | null;
  const status = Number(e?.status ?? e?.response?.status);
  if (NO_RETRY_STATUS.has(status)) throw err;
}

/**
 * `ChatOpenAICompletions`, not `ChatOpenAI`: the latter switches some model names to OpenAI's Responses API.
 * `require_parameters` keeps OpenRouter from routing to a provider that would silently drop our tools or settings
 * (https://openrouter.ai/docs/guides/routing/provider-selection). No `temperature`: Claude 5.5 rejects it and
 * OpenRouter lists no support for it, so with `require_parameters` it would leave no provider (503).
 * Transient errors (429, 5xx) propagate for pg-boss.
 */
function openRouterChat(apiKey: string, model: string, maxTokens: number, opts: ClientOptions) {
  return new ChatOpenAICompletions({
    apiKey,
    model,
    maxTokens,
    onFailedAttempt: stopRetryingUnlessTransient,
    modelKwargs: { provider: { require_parameters: true } },
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: { "X-OpenRouter-Title": "Digestor" },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    },
  });
}

/** Same contract as `createAnthropicLLM`: a JSON-schema response (no forced tool), one retry on a parse error. */
export function createOpenRouterLLM(apiKey: string, models: Record<LLMModel, string>, opts: ClientOptions = {}): StructuredLLM {
  return {
    async generate<T>(a: GenerateArgs<T>) {
      // A plain (ref-free) JSON schema, validated with zod after the call: given a zod schema, @langchain/openai
      // validates inside its HTTP retrier, which repeats a bad reply up to 6 times with backoff (each one paid).
      const json = openRouterChat(apiKey, models[a.model], 16000, opts).withStructuredOutput(llmJsonSchema(a.schema), {
        name: a.name,
        method: "jsonSchema", // response_format json_schema; Claude 5.5 rejects a forced tool call
      }).withConfig({ callbacks: usageCallbacks(models[a.model]) });
      return invokeWithOneRetry<T>(validated(json, a.schema), a);
    },
  };
}

/** Reasoning model with tools bound per call, like `createAnthropicToolLLM`. */
export function createOpenRouterToolLLM(apiKey: string, models: Record<LLMModel, string>, opts: ClientOptions = {}): ToolLLM {
  const chat = openRouterChat(apiKey, models.reasoning, 4096, opts);
  return {
    async step(a) {
      const model = a.tools.length > 0 ? chat.bindTools(a.tools) : chat;
      const res = await model.invoke([new SystemMessage(a.system), ...toLangChainMessages(a.messages)]);
      return fromAIMessage(res);
    },
  };
}
