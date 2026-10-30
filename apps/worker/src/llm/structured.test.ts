import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeFetch } from "./fakeFetch.js";
import { createAnthropicLLM } from "./structured.js";

// Claude 5.5 request rules (https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide and
// .../haiku-5-5/migration-guide): `temperature`/`top_p`/`top_k` and forced `tool_choice` return a 400, adaptive
// thinking is on by default, so replies can start with `thinking` blocks. Structured output goes through
// `output_config.format`. Response shape from the Messages API docs; UNVERIFIED against a recorded response.

const Topics = z.object({ topics: z.array(z.object({ title: z.string() })) });

const message = (content: unknown[], stop = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const thinking = { type: "thinking", thinking: "", signature: "sig-1" };

describe("Anthropic structured LLM", () => {
  it("asks for JSON through output_config.format, with no sampling parameters or forced tool choice", async () => {
    const { fetch, sent } = fakeFetch([{ body: message([thinking, { type: "text", text: '{"topics":[{"title":"Housing"}]}' }]) }]);
    const llm = createAnthropicLLM("sk-ant-test", { fetch });

    const out = await llm.generate({ schema: Topics, name: "topics", system: "You find topics.", user: "Transcript…", model: "reasoning" });

    expect(out).toEqual({ topics: [{ title: "Housing" }] });
    const body = sent[0]!.body;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(Object.keys(body.output_config.format.schema.properties)).toEqual(["topics"]);
    for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "tools", "thinking"]) expect(body).not.toHaveProperty(banned);
    expect(body.system).toEqual("You find topics.");
    expect(body.messages).toEqual([{ role: "user", content: "Transcript…" }]);
  });

  it("uses the fast model for fast calls", async () => {
    const { fetch, sent } = fakeFetch([{ body: message([{ type: "text", text: '{"topics":[]}' }]) }]);
    await createAnthropicLLM("k", { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "fast" });
    expect(sent[0]!.body.model).toBe("claude-haiku-5-5");
  });

  it("retries once on JSON that doesn't match the schema", async () => {
    const { fetch, sent } = fakeFetch([
      { body: message([{ type: "text", text: '{"topics":"Housing"}' }]) },
      { body: message([thinking, { type: "text", text: '{"topics":[{"title":"Housing"}]}' }]) },
    ]);
    const out = await createAnthropicLLM("k", { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "reasoning" });
    expect(out).toEqual({ topics: [{ title: "Housing" }] });
    expect(sent).toHaveLength(2);
  });

  it("treats a reply cut off by max_tokens as a parse error (retried once, then thrown)", async () => {
    const cut = { body: message([thinking, { type: "text", text: '{"topics":[{"title":"Hou' }], "max_tokens") };
    const { fetch, sent } = fakeFetch([cut, structuredClone(cut)]);
    await expect(
      createAnthropicLLM("k", { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "reasoning" }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });
});
