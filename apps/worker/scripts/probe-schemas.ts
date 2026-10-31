/**
 * Live check that the configured LLM provider accepts every agent output schema (Claude structured outputs reject
 * refs outside `$defs` and more than 16 union-typed parameters). One tiny call per schema; costs a fraction of a cent
 * on Haiku. Run in the worker container: `pnpm --filter @digestor/worker exec tsx scripts/probe-schemas.ts`
 */
import type { z } from "zod";
import { BriefingOutput } from "../src/agents/briefing.js";
import { ChecksOutput } from "../src/agents/checks.js";
import { ContextCardOutput } from "../src/agents/context.js";
import { MomentsOutput, PunchlinesOutput } from "../src/agents/moments.js";
import { TopicsOutput } from "../src/agents/topics.js";
import { TranslationOutput } from "../src/agents/translate.js";
import { createOpenRouterLLM } from "../src/llm/openrouter.js";
import { llmConfigFromEnv } from "../src/llm/provider.js";
import { createAnthropicLLM } from "../src/llm/structured.js";

const cfg = llmConfigFromEnv();
const key = process.env[cfg.keyVar];
if (!key) throw new Error(`${cfg.keyVar} is not set.`);
const llm = cfg.provider === "openrouter" ? createOpenRouterLLM(key, cfg.models) : createAnthropicLLM(key);

const schemas: [string, z.ZodType<unknown>][] = [
  ["context", ContextCardOutput],
  ["topics", TopicsOutput],
  ["moments", MomentsOutput],
  ["punchlines", PunchlinesOutput],
  ["briefing", BriefingOutput],
  ["checks", ChecksOutput],
  ["translation", TranslationOutput],
];

console.log(`provider ${cfg.provider}, model ${cfg.models.fast}`);
let failed = 0;
for (const [name, schema] of schemas) {
  try {
    await llm.generate({
      schema,
      name,
      system: "You test a JSON schema. Reply with the smallest valid object: empty arrays, null where allowed, short strings, 0 for numbers.",
      user: "Return the smallest valid object.",
      model: "fast",
    });
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    const e = err as { error?: { metadata?: { raw?: string } }; message?: string };
    console.log(`FAIL  ${name}: ${(e.error?.metadata?.raw ?? e.message ?? String(err)).slice(0, 300)}`);
  }
}
process.exit(failed ? 1 : 0);
