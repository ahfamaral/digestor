import { ChatAnthropic } from "@langchain/anthropic";
import { OutputParserException } from "@langchain/core/output_parsers";
import { ZodError, type z } from "zod";

export type LLMModel = "reasoning" | "fast";

export interface StructuredLLM {
  /** Model ids to record on analysis versions (provider-qualified); `MODEL_IDS` when absent. */
  modelIds?: Record<LLMModel, string>;
  generate<T>(a: { schema: z.ZodType<T>; name: string; system: string; user: string; model: LLMModel }): Promise<T>;
}

export const MODEL_IDS: Record<LLMModel, string> = {
  reasoning: "claude-sonnet-5-5",
  fast: "claude-haiku-5-5",
};

/** Test seam: route the SDK's HTTP calls through a fake. */
export type ClientOptions = { fetch?: typeof globalThis.fetch };

/**
 * Claude 5.5 rejects `temperature` (and top_p/top_k) and forced `tool_choice`, and thinks by default, so structured
 * output goes through `output_config.format` (LangChain's "jsonSchema"), whose text block the parser reads.
 * https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
 */
export function createAnthropicLLM(apiKey: string, opts: ClientOptions = {}): StructuredLLM {
  return {
    async generate<T>(a: { schema: z.ZodType<T>; name: string; system: string; user: string; model: LLMModel }) {
      const chat = new ChatAnthropic({
        apiKey,
        model: MODEL_IDS[a.model],
        maxTokens: 16000,
        ...(opts.fetch ? { clientOptions: { fetch: opts.fetch } } : {}),
      }).withStructuredOutput(a.schema, { name: a.name, method: "jsonSchema" });
      return invokeWithOneRetry<T>(chat, a);
    },
  };
}

/**
 * Invokes a structured-output chat, retrying once on a parse error (then rethrowing). Shared by every provider.
 * A reply that parses to nothing (e.g. prose instead of a forced tool call) counts as a parse error too.
 */
export async function invokeWithOneRetry<T>(
  chat: { invoke(messages: [string, string][]): Promise<unknown> },
  a: { system: string; user: string },
): Promise<T> {
  const messages: [string, string][] = [
    ["system", a.system],
    ["human", a.user],
  ];
  const once = async () => {
    const out = await chat.invoke(messages);
    if (out == null) throw new OutputParserException("The model replied without the structured output.");
    return out as T;
  };
  try {
    return await once();
  } catch (err) {
    if (!isParseError(err)) throw err;
    return once(); // one retry, then rethrow
  }
}

/** A reply that isn't the JSON we asked for (`SyntaxError`: JSON.parse inside the OpenAI SDK's `parse`). */
export function isParseError(err: unknown): boolean {
  return err instanceof ZodError || err instanceof OutputParserException || err instanceof SyntaxError;
}

export type FakeCall = { name: string; system: string; user: string; model: LLMModel };
/** A canned response, or a function of the call (may be async: block on a promise, throw, or read ids from the prompt). */
export type FakeResponse = unknown;

export class FakeLLM implements StructuredLLM {
  calls: FakeCall[] = [];
  private queue: FakeResponse[];
  private byName: Map<string, FakeResponse[]> | null;
  /** FIFO list, or `{ byName: { topics: [...] } }` so concurrent fan-out tests don't depend on call order. */
  constructor(responses: FakeResponse[] | { byName: Record<string, FakeResponse[]> }) {
    if (Array.isArray(responses)) {
      this.queue = [...responses];
      this.byName = null;
    } else {
      this.queue = [];
      this.byName = new Map(Object.entries(responses.byName).map(([k, v]) => [k, [...v]]));
    }
  }
  async generate<T>(a: { schema: z.ZodType<T>; name: string; system: string; user: string; model: LLMModel }): Promise<T> {
    const call: FakeCall = { name: a.name, system: a.system, user: a.user, model: a.model };
    this.calls.push(call);
    const q = this.byName ? (this.byName.get(a.name) ?? []) : this.queue;
    if (q.length === 0) throw new Error(`FakeLLM response queue is empty (call "${a.name}")`);
    const next = q.shift();
    const value = typeof next === "function" ? await (next as (c: FakeCall) => unknown)(call) : next;
    return a.schema.parse(value);
  }
}
