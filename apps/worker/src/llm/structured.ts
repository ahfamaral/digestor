import { ChatAnthropic } from "@langchain/anthropic";
import { OutputParserException } from "@langchain/core/output_parsers";
import { ZodError, type z } from "zod";

export type LLMModel = "reasoning" | "fast";

export interface StructuredLLM {
  generate<T>(a: { schema: z.ZodType<T>; name: string; system: string; user: string; model: LLMModel }): Promise<T>;
}

export const MODEL_IDS: Record<LLMModel, string> = {
  reasoning: "claude-sonnet-5-5",
  fast: "claude-haiku-5-5",
};

export function createAnthropicLLM(apiKey: string): StructuredLLM {
  return {
    async generate<T>(a: { schema: z.ZodType<T>; name: string; system: string; user: string; model: LLMModel }) {
      const chat = new ChatAnthropic({
        apiKey,
        model: MODEL_IDS[a.model],
        temperature: 0,
        maxTokens: 16000,
      }).withStructuredOutput(a.schema, { name: a.name });
      const messages: [string, string][] = [
        ["system", a.system],
        ["human", a.user],
      ];
      try {
        return (await chat.invoke(messages)) as T;
      } catch (err) {
        if (!isParseError(err)) throw err;
        return (await chat.invoke(messages)) as T; // one retry, then rethrow
      }
    },
  };
}

export function isParseError(err: unknown): boolean {
  return err instanceof ZodError || err instanceof OutputParserException;
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
