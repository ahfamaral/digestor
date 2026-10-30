import { MODEL_IDS, type LLMModel } from "./structured.js";

export type LLMProvider = "anthropic" | "openrouter";

/** Which LLM vendor the worker calls, the key it needs and the models it uses (transcription stays on AssemblyAI). */
export type LLMConfig = {
  provider: LLMProvider;
  keyVar: "ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY";
  /** Ids sent to the provider. */
  models: Record<LLMModel, string>;
  /** Ids stored on each analysis version: plain for Anthropic (as before), `openrouter:<id>` for OpenRouter. */
  recordedModels: Record<LLMModel, string>;
};

/** OpenRouter ids for the spec's models (checked against https://openrouter.ai/api/v1/models on 2026-10-30). */
export const OPENROUTER_DEFAULT_MODELS: Record<LLMModel, string> = {
  reasoning: "anthropic/claude-sonnet-5.5",
  fast: "anthropic/claude-haiku-5.5",
};

type Env = Record<string, string | undefined>;

const setting = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

/** Reads `LLM_PROVIDER` (default anthropic) and, for OpenRouter, `OPENROUTER_MODEL_REASONING` / `OPENROUTER_MODEL_FAST`. */
export function llmConfigFromEnv(env: Env = process.env): LLMConfig {
  const provider = (setting(env, "LLM_PROVIDER") ?? "anthropic").toLowerCase();
  if (provider === "anthropic") {
    return { provider, keyVar: "ANTHROPIC_API_KEY", models: MODEL_IDS, recordedModels: MODEL_IDS };
  }
  if (provider === "openrouter") {
    const models = {
      reasoning: setting(env, "OPENROUTER_MODEL_REASONING") ?? OPENROUTER_DEFAULT_MODELS.reasoning,
      fast: setting(env, "OPENROUTER_MODEL_FAST") ?? OPENROUTER_DEFAULT_MODELS.fast,
    };
    return {
      provider,
      keyVar: "OPENROUTER_API_KEY",
      models,
      recordedModels: { reasoning: `openrouter:${models.reasoning}`, fast: `openrouter:${models.fast}` },
    };
  }
  throw new Error(`LLM_PROVIDER must be "anthropic" or "openrouter" (got "${env.LLM_PROVIDER?.trim()}").`);
}
