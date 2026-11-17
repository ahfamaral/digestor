import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, ToolMessage as LcToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeFetch } from "./fakeFetch.js";
import { createAnthropicToolLLM, FakeToolLLM, fromAIMessage, toLangChainMessages, type ToolMessage, type ToolSpec } from "./tools.js";

const spec: ToolSpec = {
  name: "get_transcript",
  description: "Transcript between two timestamps.",
  schema: z.object({ start: z.string().describe("hh:mm:ss"), end: z.string() }),
};

describe("Anthropic tool adapter", () => {
  it("formats a ToolSpec as an Anthropic tool with a JSON schema", () => {
    const chat = new ChatAnthropic({ apiKey: "x", model: "claude-sonnet-5-5" });
    const [tool] = chat.formatStructuredToolToAnthropic([spec]) as { name: string; description: string; input_schema: { properties: object } }[];
    expect(tool).toMatchObject({ name: "get_transcript", description: "Transcript between two timestamps." });
    expect(Object.keys(tool!.input_schema.properties)).toEqual(["start", "end"]);
  });

  it("maps port messages to LangChain messages (tool calls keep their ids; non-object args become {})", () => {
    const out = toLangChainMessages([
      { role: "user", text: "Q?" },
      { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "list_topics", args: {} }, { id: "t2", name: "x", args: "not json" }] },
      { role: "tool", toolCallId: "t1", content: "Topics…" },
      { role: "tool", toolCallId: "t2", content: "Invalid arguments" },
    ]);
    expect(out[0]).toBeInstanceOf(HumanMessage);
    const ai = out[1] as AIMessage;
    expect(ai).toBeInstanceOf(AIMessage);
    expect(ai.tool_calls?.map((c) => [c.id, c.name, c.args])).toEqual([
      ["t1", "list_topics", {}],
      ["t2", "x", {}],
    ]);
    expect(out[2]).toBeInstanceOf(LcToolMessage);
    expect((out[2] as LcToolMessage).tool_call_id).toBe("t1");
    expect(out[3]!.content).toBe("Invalid arguments");
  });

  it("reads text, tool calls and unparseable tool calls from the model's message", () => {
    const msg = new AIMessage({
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "a", name: "search_transcript", input: { query: "housing" } },
      ],
      tool_calls: [{ id: "a", name: "search_transcript", args: { query: "housing" }, type: "tool_call" }],
      invalid_tool_calls: [{ id: "b", name: "get_transcript", args: "{bad", error: "parse", type: "invalid_tool_call" }],
    });
    expect(fromAIMessage(msg)).toMatchObject({
      text: "Let me look.",
      toolCalls: [
        { id: "a", name: "search_transcript", args: { query: "housing" } },
        { id: "b", name: "get_transcript", args: "{bad" },
      ],
    });
  });
});

describe("FakeToolLLM", () => {
  it("replays steps in order, records calls and fails when empty", async () => {
    const fake = new FakeToolLLM([{ text: "", toolCalls: [{ id: "1", name: "list_topics", args: {} }] }, (c) => ({ text: `seen ${c.messages.length}`, toolCalls: [] })]);
    const first = await fake.step({ system: "s", messages: [{ role: "user", text: "q" }], tools: [spec] });
    expect(first.toolCalls[0]!.name).toBe("list_topics");
    const second = await fake.step({ system: "s", messages: [{ role: "user", text: "q" }, { role: "user", text: "q2" }], tools: [] });
    expect(second.text).toBe("seen 2");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.tools.map((t) => t.name)).toEqual(["get_transcript"]);
    await expect(fake.step({ system: "s", messages: [], tools: [] })).rejects.toThrow(/empty/);
  });
});

describe("Anthropic tool LLM (Ask) on the wire", () => {
  // Claude 5.5: no sampling parameters; adaptive thinking is on by default, and a thinking block must go back
  // unchanged with the assistant turn that produced it (https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).
  // UNVERIFIED against a recorded response (scripts/smoke.md §3).
  const reply = (content: unknown[], stop: string) => ({
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
  });
  const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
  const toolUse = { type: "tool_use", id: "toolu_1", name: "get_transcript", input: { start: "00:01:00", end: "00:02:00" } };

  it("sends no sampling parameters and replays the turn's thinking block with its tool call", async () => {
    const { fetch, sent } = fakeFetch([
      { body: reply([thinking, toolUse], "tool_use") },
      { body: reply([{ type: "text", text: "Housing came up at [00:01:10]." }], "end_turn") },
    ]);
    const llm = createAnthropicToolLLM("k", { fetch });

    const messages: ToolMessage[] = [{ role: "user", text: "Housing?" }];
    const first = await llm.step({ system: "s", messages, tools: [spec] });
    expect(first.toolCalls).toEqual([{ id: "toolu_1", name: "get_transcript", args: { start: "00:01:00", end: "00:02:00" } }]);
    messages.push({ role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw });
    messages.push({ role: "tool", toolCallId: "toolu_1", content: "[00:01:10] Housing…" });
    const second = await llm.step({ system: "s", messages, tools: [spec] });

    expect(second).toMatchObject({ text: "Housing came up at [00:01:10].", toolCalls: [] });
    for (const req of sent) {
      for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "thinking"]) expect(req.body).not.toHaveProperty(banned);
    }
    const assistant = sent[1]!.body.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([thinking, toolUse]);
    expect(sent[1]!.body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(sent[0]!.body.max_tokens).toBe(16000); // thinking counts against it: as much room as the structured calls
    expect(second.cutOff).toBeUndefined();
  });

  it("marks a reply cut off by the token limit (stop_reason max_tokens)", async () => {
    const { fetch } = fakeFetch([{ body: reply([thinking, { type: "text", text: "Housing came up at [00:01" }], "max_tokens") }]);
    const step = await createAnthropicToolLLM("k", { fetch }).step({ system: "s", messages: [{ role: "user", text: "Housing?" }], tools: [spec] });
    expect(step).toMatchObject({ text: "Housing came up at [00:01", toolCalls: [], cutOff: true });
  });
});
