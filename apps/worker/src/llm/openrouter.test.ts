import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TopicsOutput } from "../agents/topics.js";
import { fakeFetch } from "./fakeFetch.js";
import { createOpenRouterLLM, createOpenRouterToolLLM, OPENROUTER_BASE_URL } from "./openrouter.js";
import type { ToolMessage, ToolSpec } from "./tools.js";

// Fakes speak OpenRouter's OpenAI-compatible Chat Completions format:
// https://openrouter.ai/docs/api-reference/overview (request/response, tool_calls) and
// https://openrouter.ai/docs/api-reference/errors (error body { error: { code, message } }).
// Claude 5.5 rejects sampling parameters and forced tool choice, and OpenRouter lists no `temperature` for it
// (https://openrouter.ai/api/v1/models, 2026-10-30), so neither is sent.
// Recorded responses (2026-10-31, Haiku 5.5) are in test/fixtures/openrouter and tested at the end of this file.

const MODELS = { reasoning: "anthropic/claude-sonnet-5.5", fast: "anthropic/claude-haiku-5.5" };

function completion(message: Record<string, unknown>, finish = "stop") {
  return {
    id: "gen-1",
    object: "chat.completion",
    created: 1761800000,
    model: "anthropic/claude-sonnet-5.5",
    provider: "Anthropic",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, ...message } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const toolCall = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });

const Topics = z.object({ topics: z.array(z.object({ title: z.string() })) });

describe("OpenRouter structured LLM", () => {
  it("asks OpenRouter for a JSON schema response, with no sampling parameters or forced tool, and parses it", async () => {
    const { fetch, sent } = fakeFetch([{ body: completion({ content: '{"topics":[{"title":"Housing"}]}' }) }]);
    const llm = createOpenRouterLLM("sk-or-test", MODELS, { fetch });

    const out = await llm.generate({ schema: Topics, name: "topics", system: "You find topics.", user: "Transcript…", model: "reasoning" });

    expect(out).toEqual({ topics: [{ title: "Housing" }] });
    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req!.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(req!.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(req!.headers.get("x-openrouter-title")).toBe("Digestor");
    expect(req!.body).toMatchObject({
      model: "anthropic/claude-sonnet-5.5",
      provider: { require_parameters: true },
      response_format: { type: "json_schema", json_schema: { name: "topics" } },
      messages: [
        { role: "system", content: "You find topics." },
        { role: "user", content: "Transcript…" },
      ],
    });
    expect(Object.keys(req!.body.response_format.json_schema.schema.properties)).toEqual(["topics"]);
    for (const banned of ["temperature", "top_p", "top_k", "tools", "tool_choice"]) expect(req!.body).not.toHaveProperty(banned);
  });

  it("uses the fast model for fast calls", async () => {
    const { fetch, sent } = fakeFetch([{ body: completion({ content: '{"topics":[]}' }) }]);
    await createOpenRouterLLM("k", MODELS, { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "fast" });
    expect(sent[0]!.body.model).toBe("anthropic/claude-haiku-5.5");
  });

  it("retries once when the JSON doesn't match the schema, then returns the good answer", async () => {
    const { fetch, sent } = fakeFetch([
      { body: completion({ content: '{"topics":"Housing"}' }) },
      { body: completion({ content: '{"topics":[{"title":"Housing"}]}' }) },
    ]);
    const out = await createOpenRouterLLM("k", MODELS, { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "reasoning" });
    expect(out).toEqual({ topics: [{ title: "Housing" }] });
    expect(sent).toHaveLength(2);
  });

  it("gives up after the one retry when the model keeps answering in prose", async () => {
    const prose = { body: completion({ content: "Here are the topics: housing." }) };
    const { fetch, sent } = fakeFetch([prose, structuredClone(prose)]);
    await expect(
      createOpenRouterLLM("k", MODELS, { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "reasoning" }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });

  it("still retries a transient provider error (502) itself", async () => {
    const { fetch, sent } = fakeFetch([
      { status: 502, body: { error: { code: 502, message: "Provider returned error" } } },
      { body: completion({ content: '{"topics":[]}' }) },
    ]);
    const out = await createOpenRouterLLM("k", MODELS, { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "reasoning" });
    expect(out).toEqual({ topics: [] });
    expect(sent).toHaveLength(2);
  });

  it("does not retry an out-of-credits error itself (402)", async () => {
    const { fetch, sent } = fakeFetch([{ status: 402, body: { error: { code: 402, message: "Insufficient credits" } } }]);
    await expect(
      createOpenRouterLLM("k", MODELS, { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "reasoning" }),
    ).rejects.toThrow(/402|credits/i);
    expect(sent).toHaveLength(1);
  });
});

const search: ToolSpec = {
  name: "search_transcript",
  description: "Search the transcript.",
  schema: z.object({ query: z.string() }),
};

describe("OpenRouter tool LLM (Ask)", () => {
  it("sends tools and the conversation in OpenAI format and maps the reply's tool calls", async () => {
    const { fetch, sent } = fakeFetch([
      {
        body: completion({
          content: "Let me look.",
          tool_calls: [toolCall("a", "search_transcript", '{"query":"housing"}'), toolCall("b", "get_transcript", "{bad")],
        }),
      },
    ]);
    const llm = createOpenRouterToolLLM("k", MODELS, { fetch });

    const step = await llm.step({
      system: "You answer questions.",
      tools: [search],
      messages: [
        { role: "user", text: "What about housing?" },
        { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "list_topics", args: {} }] },
        { role: "tool", toolCallId: "t1", content: "1. Housing" },
      ],
    });

    expect(step).toMatchObject({
      text: "Let me look.",
      toolCalls: [
        { id: "a", name: "search_transcript", args: { query: "housing" } },
        { id: "b", name: "get_transcript", args: "{bad" },
      ],
    });
    const body = sent[0]!.body;
    expect(body).toMatchObject({ model: "anthropic/claude-sonnet-5.5", provider: { require_parameters: true } });
    expect(body).not.toHaveProperty("temperature");
    expect(body.tools.map((t: any) => [t.type, t.function.name])).toEqual([["function", "search_transcript"]]);
    expect(body.tool_choice).toBeUndefined();
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[2].tool_calls[0]).toMatchObject({ id: "t1", type: "function", function: { name: "list_topics", arguments: "{}" } });
    expect(body.messages[3]).toMatchObject({ tool_call_id: "t1", content: "1. Housing" });
  });

  it("sends no tools when none are given and returns plain text", async () => {
    const { fetch, sent } = fakeFetch([{ body: completion({ content: "  Housing came up twice.  " }, "stop") }]);
    const step = await createOpenRouterToolLLM("k", MODELS, { fetch }).step({ system: "s", tools: [], messages: [{ role: "user", text: "q" }] });
    expect(step).toMatchObject({ text: "Housing came up twice.", toolCalls: [] });
    expect(sent[0]!.body.tools).toBeUndefined();
  });
});

// Real responses recorded through openrouter.ts on 2026-10-31 (anthropic/claude-haiku-5.5, served by "Claude Platform
// on AWS"). Each fixture keeps the request we sent and the raw response. Thinking comes back as `reasoning_details`
// (signed blocks), which @langchain/openai 1.8 drops, so it is not replayed; OpenRouter accepted a third round both
// with and without it (checked by hand the same day).
describe("OpenRouter recorded responses", () => {
  const recorded = (name: string) =>
    JSON.parse(readFileSync(new URL(`../../test/fixtures/openrouter/${name}.recorded.json`, import.meta.url), "utf8"));

  it("a structured reply (real topics schema) parses, from a request shaped like the one recorded", async () => {
    const rec = recorded("topics");
    const { fetch, sent } = fakeFetch([{ body: rec.response }]);
    const out = await createOpenRouterLLM("k", { reasoning: rec.request.model, fast: "x" }, { fetch }).generate({
      schema: TopicsOutput, name: "topics", model: "reasoning", system: "s", user: "u",
    });
    expect(out.topics.length).toBeGreaterThan(0);
    for (const t of out.topics) expect(t.start).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(Object.keys(sent[0]!.body).sort()).toEqual(Object.keys(rec.request).sort());
    expect(sent[0]!.body.response_format).toEqual(rec.request.response_format);
  });

  it("Ask: a recorded tool call, then the recorded answer, with the assistant turn replayed as recorded", async () => {
    const call = recorded("ask-tool-call");
    const answer = recorded("ask-answer");
    const { fetch, sent } = fakeFetch([{ body: call.response }, { body: answer.response }]);
    const llm = createOpenRouterToolLLM("k", { reasoning: call.request.model, fast: "x" }, { fetch });
    const search: ToolSpec = {
      name: "search_transcript",
      description: call.request.tools[0].function.description,
      schema: z.object({ query: z.string().min(1).describe("What to look for, in any language"), k: z.number().int().optional().describe("How many passages (1–10, default 5)") }),
    };
    const [system, user] = call.request.messages;

    const first = await llm.step({ system: system.content, messages: [{ role: "user", text: user.content }], tools: [search] });
    expect(first.text).toBe("");
    expect(first.toolCalls).toEqual([{ id: expect.stringMatching(/^toolu_/), name: "search_transcript", args: { query: "infraestrutura", k: 5 } }]);
    expect(sent[0]!.body.messages).toEqual(call.request.messages);
    expect(sent[0]!.body.tools).toEqual(call.request.tools);

    const tool = answer.request.messages.at(-1);
    const messages: ToolMessage[] = [
      { role: "user", text: user.content },
      { role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw },
      { role: "tool", toolCallId: tool.tool_call_id, content: tool.content },
    ];
    const second = await llm.step({ system: system.content, messages, tools: [search] });
    expect(second.toolCalls).toEqual([]);
    expect(second.text).toMatch(/\[00:03:08/);
    expect(sent[1]!.body.messages).toEqual(answer.request.messages);
  });
});
