import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, ToolMessage as LcToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeToolLLM, fromAIMessage, toLangChainMessages, type ToolSpec } from "./tools.js";

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
    expect(fromAIMessage(msg)).toEqual({
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
