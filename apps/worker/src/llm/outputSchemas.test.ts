import { describe, expect, it } from "vitest";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { z } from "zod";
import { BriefingOutput } from "../agents/briefing.js";
import { ChecksOutput } from "../agents/checks.js";
import { ContextCardOutput } from "../agents/context.js";
import { MomentsOutput, PunchlinesOutput } from "../agents/moments.js";
import { TopicsOutput } from "../agents/topics.js";
import { TranslationOutput } from "../agents/translate.js";
import { JudgeOutputSchema } from "../agents/verify.js";
import { llmJsonSchema } from "./structured.js";

// Every schema the agents send must be accepted by Claude structured outputs: refs only under `$defs`, and at most
// 16 union-typed parameters (type arrays or anyOf), each `$defs` entry counted once (verified live on 2026-10-30 with
// scripts/probe-schemas.ts: all seven accepted by anthropic/claude-haiku-5.5 via OpenRouter). OpenAI models (strict
// structured outputs) also need every property listed in `required`: an optional field is a 400 (seen live 2026-10-31
// with openai/gpt-6-luna on `checks`), so optional fields are `.nullable()` instead. Gemini and DeepSeek accept both.
const OUTPUTS: [string, z.ZodType<unknown>][] = [
  ["context", ContextCardOutput],
  ["topics", TopicsOutput],
  ["moments", MomentsOutput],
  ["punchlines", PunchlinesOutput],
  ["briefing", BriefingOutput],
  ["checks", ChecksOutput],
  ["translation", TranslationOutput],
  ["verify_claims", JudgeOutputSchema],
];

describe("agent output schemas as sent to the model", () => {
  it("the context card is the one zod-to-json-schema writes with #/properties refs (the live 400)", () => {
    expect(JSON.stringify(toJsonSchema(ContextCardOutput))).toContain('"$ref":"#/properties/');
  });

  it.each(OUTPUTS)("%s: refs only under $defs, at most 16 unions", (_name, schema) => {
    const json = JSON.stringify(llmJsonSchema(schema));
    expect(json).not.toContain('"#/properties');
    const unions = (json.match(/"type":\[/g) ?? []).length + (json.match(/"anyOf":/g) ?? []).length;
    expect(unions).toBeLessThanOrEqual(16);
  });

  it.each(OUTPUTS)("%s: every property is required (nullable, never optional)", (_name, schema) => {
    const missing: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      const o = node as { properties?: Record<string, unknown>; required?: string[] };
      if (o.properties) {
        for (const key of Object.keys(o.properties)) if (!o.required?.includes(key)) missing.push(`${path}.${key}`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
    };
    walk(llmJsonSchema(schema), "");
    expect(missing).toEqual([]);
  });
});
