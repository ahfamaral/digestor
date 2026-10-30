import { randomUUID } from "node:crypto";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage, HumanMessage, SystemMessage, ToolMessage as LcToolMessage, type AIMessageChunk, type BaseMessage,
} from "@langchain/core/messages";
import type { z } from "zod";
import { MODEL_IDS } from "./structured.js";

/**
 * A tool the model may call. `schema` is sent to the model as the tool's JSON schema; the tool must still validate
 * the arguments itself, because they are model output.
 */
export type ToolSpec = { name: string; description: string; schema: z.ZodObject<any> };

/** A tool call as the model sent it. `args` is unvalidated (a raw string when the model's JSON didn't parse). */
export type ToolCallRequest = { id: string; name: string; args: unknown };

export type ToolMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolStep = { text: string; toolCalls: ToolCallRequest[] };
export type ToolStepCall = { system: string; messages: ToolMessage[]; tools: ToolSpec[] };

/** One model turn with tools bound: text and/or tool calls. The caller runs the tools and loops. */
export interface ToolLLM {
  step(a: ToolStepCall): Promise<ToolStep>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Port messages → LangChain messages. Anthropic needs object `input` on tool_use blocks, so other args become {}. */
export function toLangChainMessages(messages: ToolMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (m.role === "user") return new HumanMessage(m.text);
    if (m.role === "tool") return new LcToolMessage({ content: m.content, tool_call_id: m.toolCallId });
    return new AIMessage({
      content: m.text,
      tool_calls: (m.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, args: isPlainObject(c.args) ? c.args : {}, type: "tool_call" as const })),
    });
  });
}

/** The model's reply → text + tool calls. Calls whose JSON didn't parse are kept so the tool can answer with an error. */
export function fromAIMessage(msg: AIMessage | AIMessageChunk): ToolStep {
  const ok = (msg.tool_calls ?? []).map((c) => ({ id: c.id ?? randomUUID(), name: c.name, args: c.args as unknown }));
  const bad = (msg.invalid_tool_calls ?? []).map((c) => ({ id: c.id ?? randomUUID(), name: c.name ?? "", args: c.args as unknown }));
  return { text: msg.text.trim(), toolCalls: [...ok, ...bad] };
}

/** Reasoning model, temperature 0, tools bound per call. Transient vendor errors (429/529) propagate for pg-boss. */
export function createAnthropicToolLLM(apiKey: string): ToolLLM {
  const chat = new ChatAnthropic({ apiKey, model: MODEL_IDS.reasoning, temperature: 0, maxTokens: 4096 });
  return {
    async step(a) {
      const model = a.tools.length > 0 ? chat.bindTools(a.tools) : chat;
      const res = await model.invoke([new SystemMessage(a.system), ...toLangChainMessages(a.messages)]);
      return fromAIMessage(res);
    },
  };
}

/** A canned step, or a function of the call (may throw, or read the tool results it was given). */
export type FakeToolStep = ToolStep | ((c: ToolStepCall) => ToolStep | Promise<ToolStep>);

export class FakeToolLLM implements ToolLLM {
  calls: ToolStepCall[] = [];
  private queue: FakeToolStep[];
  constructor(steps: FakeToolStep[]) {
    this.queue = [...steps];
  }
  async step(a: ToolStepCall): Promise<ToolStep> {
    const call: ToolStepCall = { system: a.system, messages: structuredClone(a.messages), tools: [...a.tools] };
    this.calls.push(call);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeToolLLM step queue is empty");
    return typeof next === "function" ? next(call) : next;
  }
}
