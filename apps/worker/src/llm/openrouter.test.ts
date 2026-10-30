import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeFetch } from "./fakeFetch.js";
import { createOpenRouterLLM, createOpenRouterToolLLM, OPENROUTER_BASE_URL } from "./openrouter.js";
import type { ToolSpec } from "./tools.js";

// Fakes speak OpenRouter's OpenAI-compatible Chat Completions format:
// https://openrouter.ai/docs/api-reference/overview (request/response, tool_calls) and
// https://openrouter.ai/docs/api-reference/errors (error body { error: { code, message } }).
// Claude 5.5 rejects sampling parameters and forced tool choice, and OpenRouter lists no `temperature` for it
// (https://openrouter.ai/api/v1/models, 2026-10-30), so neither is sent.
// UNVERIFIED against a recorded response until the smoke run (scripts/smoke.md §4).

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
