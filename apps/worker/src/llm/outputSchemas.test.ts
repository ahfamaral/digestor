import { describe, expect, it } from "vitest";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { z } from "zod";
import { BriefingOutput } from "../agents/briefing.js";
import { ChecksOutput } from "../agents/checks.js";
import { ContextCardOutput } from "../agents/context.js";
import { MomentsOutput, PunchlinesOutput } from "../agents/moments.js";
import { TopicsOutput } from "../agents/topics.js";
import { TranslationOutput } from "../agents/translate.js";
import { llmJsonSchema } from "./structured.js";

// Every schema the agents send must be accepted by Claude structured outputs: refs only under `$defs`, and at most
// 16 union-typed parameters (type arrays or anyOf), each `$defs` entry counted once (verified live on 2026-10-30 with
// scripts/probe-schemas.ts: all seven accepted by anthropic/claude-haiku-5.5 via OpenRouter).
const OUTPUTS: [string, z.ZodType<unknown>][] = [
  ["context", ContextCardOutput],
  ["topics", TopicsOutput],
  ["moments", MomentsOutput],
  ["punchlines", PunchlinesOutput],
  ["briefing", BriefingOutput],
  ["checks", ChecksOutput],
  ["translation", TranslationOutput],
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
});
