import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeFetch } from "./fakeFetch.js";
import { createOpenRouterLLM } from "./openrouter.js";
import { createAnthropicLLM, llmJsonSchema } from "./structured.js";

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

  const PIXEL = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD"; // tiny fake base64, not a real JPEG

  it("anthropic adapter sends the image as a content part next to the text", async () => {
    const { fetch, sent } = fakeFetch([{ body: message([{ type: "text", text: '{"topics":[{"title":"Housing"}]}' }]) }]);
    const llm = createAnthropicLLM("sk-ant-test", { fetch });

    await llm.generate({
      schema: Topics, name: "topics", system: "You read captions.", user: "What does the caption say?", model: "fast",
      images: [{ mediaType: "image/jpeg", data: PIXEL }],
    });

    expect(sent[0]!.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PIXEL } },
          { type: "text", text: "What does the caption say?" },
        ],
      },
    ]);
    expect(sent[0]!.body.system).toBe("You read captions.");
    for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "tools"]) expect(sent[0]!.body).not.toHaveProperty(banned);
  });

  it("no images: request body unchanged (plain string content)", async () => {
    const { fetch, sent } = fakeFetch([{ body: message([{ type: "text", text: '{"topics":[]}' }]) }]);
    await createAnthropicLLM("k", { fetch }).generate({ schema: Topics, name: "topics", system: "s", user: "u", model: "fast", images: [] });
    expect(sent[0]!.body.messages).toEqual([{ role: "user", content: "u" }]);
  });

  it("image request matches the fixture's wire body and its reply parses", async () => {
    const fx = JSON.parse(readFileSync(new URL("../../test/fixtures/vision-caption-anthropic.json", import.meta.url), "utf8"));
    const { fetch, sent } = fakeFetch([{ body: fx.response }]);
    const out = await createAnthropicLLM("k", { fetch }).generate({
      schema: z.object({ person: z.string().nullable(), role: z.string().nullable() }), name: "caption", model: "fast",
      system: fx.request.system, user: fx.request.messages[0].content[1].text, images: [{ mediaType: "image/jpeg", data: PIXEL }],
    });
    expect(out).toEqual({ person: "FLÁVIO", role: null });
    expect(sent[0]!.body).toEqual(JSON.parse(JSON.stringify(fx.request).replace("<BASE64_JPEG_FRAME>", PIXEL)));
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

describe("llmJsonSchema", () => {
  // Claude structured outputs reject `$ref`s outside `$defs` (seen live 2026-10-30: "References must be defined under
  // '$defs' or 'definitions', not 'properties': #/properties/language"); zod-to-json-schema emits them for reused schemas.
  const Fact = z.object({ value: z.string().nullable(), source: z.string(), evidence: z.string() });
  const Card = z.object({ language: Fact, topic: Fact, participants: z.array(z.object({ name: Fact, role: Fact })) });

  it("moves reused shapes to $defs and points every use there", () => {
    const json = llmJsonSchema(Card) as any;
    const refs = JSON.stringify(json).match(/"\$ref":"[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r).toMatch(/"\$ref":"#\/\$defs\/def\d+"/);
    expect(json.properties.language).toEqual(json.properties.topic);
    const fact = json.$defs[json.properties.language.$ref.split("/").pop()];
    expect(fact.properties.evidence).toEqual({ type: "string" });
  });

  it("is what both providers send", async () => {
    const f = { value: "pt", source: "video", evidence: "Boa noite" };
    const reply = { body: message([{ type: "text", text: JSON.stringify({ language: f, topic: f, participants: [] }) }]) };
    const anthropic = fakeFetch([reply]);
    await createAnthropicLLM("k", { fetch: anthropic.fetch }).generate({ schema: Card, name: "context", system: "s", user: "u", model: "reasoning" });
    expect(JSON.stringify(anthropic.sent[0]!.body.output_config.format.schema)).not.toContain('"#/properties');

    const openrouter = fakeFetch([{ body: { id: "g", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ language: f, topic: f, participants: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }]);
    await createOpenRouterLLM("k", { reasoning: "a", fast: "b" }, { fetch: openrouter.fetch }).generate({ schema: Card, name: "context", system: "s", user: "u", model: "reasoning" });
    expect(JSON.stringify(openrouter.sent[0]!.body.response_format.json_schema.schema)).not.toContain('"#/properties');
  });

  it("still validates the reply with the zod schema (a bad reply is a parse error, retried once)", async () => {
    const bad = { body: message([{ type: "text", text: '{"language":"pt"}' }]) };
    const { fetch, sent } = fakeFetch([bad, structuredClone(bad)]);
    await expect(createAnthropicLLM("k", { fetch }).generate({ schema: Card, name: "context", system: "s", user: "u", model: "reasoning" })).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });
});
