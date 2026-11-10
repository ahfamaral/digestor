/**
 * Live check that an LLM accepts every agent output schema (Claude structured outputs reject refs outside `$defs` and
 * more than 16 union-typed parameters; other vendors have their own limits). One tiny call per schema; a fraction of
 * a cent per model. Run in the worker container:
 *
 *   pnpm --filter @digestor/worker exec tsx scripts/probe-schemas.ts
 *   pnpm --filter @digestor/worker exec tsx scripts/probe-schemas.ts --models openai/gpt-6-luna,typesafe/jev-router [--record test/fixtures/openrouter]
 *
 * Without `--models` it probes the configured provider's fast model. `--models` takes OpenRouter ids (needs
 * `OPENROUTER_API_KEY`) and prints, per model, which schemas passed, the model that actually answered (a router
 * picks one per request) and the tokens and dollars charged. `--record <dir>` saves each model's raw reply to the
 * checks schema as `<dir>/usage-<model>.recorded.json` (vendor-contract-check).
 */
import { writeFileSync } from "node:fs";
import type { z } from "zod";
import { BriefingOutput } from "../src/agents/briefing.js";
import { ChecksOutput } from "../src/agents/checks.js";
import { ContextCardOutput } from "../src/agents/context.js";
import { MomentsOutput, PunchlinesOutput } from "../src/agents/moments.js";
import { TopicsOutput } from "../src/agents/topics.js";
import { TranslationOutput } from "../src/agents/translate.js";
import { createOpenRouterLLM } from "../src/llm/openrouter.js";
import { llmConfigFromEnv } from "../src/llm/provider.js";
import { createAnthropicLLM, type StructuredLLM } from "../src/llm/structured.js";
import { UsageMeter, withUsageMeter } from "../src/llm/usage.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelList = opt("--models")?.split(",").map((m) => m.trim()).filter(Boolean);
const recordDir = opt("--record");

const schemas: [string, z.ZodType<unknown>][] = [
  ["context", ContextCardOutput],
  ["topics", TopicsOutput],
  ["moments", MomentsOutput],
  ["punchlines", PunchlinesOutput],
  ["briefing", BriefingOutput],
  ["checks", ChecksOutput],
  ["translation", TranslationOutput],
];

/** A fetch that keeps the raw JSON body of the last reply, to record it. */
function recordingFetch() {
  const last: { body: unknown; request: unknown } = { body: null, request: null };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await globalThis.fetch(input, init);
    const text = await res.clone().text();
    try {
      last.body = JSON.parse(text);
      const req = JSON.parse(String(init?.body ?? "{}"));
      last.request = { model: req.model, provider: req.provider, response_format: { type: req.response_format?.type, name: req.response_format?.json_schema?.name } };
    } catch {
      last.body = text;
    }
    return res;
  }) as typeof globalThis.fetch;
  return { fetch, last };
}

async function probe(llm: StructuredLLM, label: string, onChecks?: () => void): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const [name, schema] of schemas) {
    try {
      await llm.generate({
        schema,
        name,
        system: "You test a JSON schema. Reply with the smallest valid object: empty arrays, null where allowed, short strings, 0 for numbers.",
        user: "Return the smallest valid object.",
        model: "fast",
      });
      console.log(`ok    ${label} ${name}`);
      if (name === "checks") onChecks?.();
    } catch (err) {
      failed.push(name);
      const e = err as { error?: { metadata?: { raw?: string } }; message?: string };
      console.log(`FAIL  ${label} ${name}: ${(e.error?.metadata?.raw ?? e.message ?? String(err)).slice(0, 300)}`);
    }
  }
  return { failed };
}

if (!modelList) {
  const cfg = llmConfigFromEnv();
  const key = process.env[cfg.keyVar];
  if (!key) throw new Error(`${cfg.keyVar} is not set.`);
  const llm = cfg.provider === "openrouter" ? createOpenRouterLLM(key, cfg.models) : createAnthropicLLM(key);
  console.log(`provider ${cfg.provider}, model ${cfg.models.fast}`);
  const { failed } = await probe(llm, cfg.models.fast);
  process.exit(failed.length ? 1 : 0);
}

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
const summary: string[] = [];
let anyFailed = false;
for (const model of modelList) {
  const rec = recordingFetch();
  const llm = createOpenRouterLLM(key, { reasoning: model, fast: model }, { fetch: rec.fetch });
  const meter = new UsageMeter();
  const { failed } = await withUsageMeter(meter, () =>
    probe(llm, model, () => {
      if (!recordDir) return;
      const file = `${recordDir}/usage-${model.replace(/[^a-z0-9.-]+/gi, "_")}.recorded.json`;
      const _meta = { date: new Date().toISOString().slice(0, 10), sdk: "@langchain/openai 1.8.0", input: "probe-schemas checks schema, smallest valid object", request: rec.last.request };
      writeFileSync(file, JSON.stringify({ _meta, response: rec.last.body }, null, 2) + "\n");
    }),
  );
  anyFailed ||= failed.length > 0;
  const usage = meter.report();
  const served = Object.keys(usage).join(", ") || "none";
  const cost = Object.values(usage).reduce((n, u) => n + u.costUsd, 0);
  const tokens = Object.values(usage).reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
  summary.push(`| ${model} | ${schemas.length - failed.length}/${schemas.length}${failed.length ? ` (failed: ${failed.join(", ")})` : ""} | ${served} | ${tokens} | $${cost.toFixed(5)} |`);
}
console.log("\n| Model | Schemas accepted | Served by | Tokens | Cost |\n| --- | --- | --- | --- | --- |");
for (const row of summary) console.log(row);
process.exit(anyFailed ? 1 : 0);
