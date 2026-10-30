import { describe, expect, it } from "vitest";
import { llmConfigFromEnv, OPENROUTER_DEFAULT_MODELS } from "./provider.js";
import { MODEL_IDS } from "./structured.js";

describe("llmConfigFromEnv", () => {
  it("defaults to Anthropic with the spec's models, recorded as plain ids", () => {
    for (const env of [{}, { LLM_PROVIDER: "" }, { LLM_PROVIDER: " Anthropic " }]) {
      expect(llmConfigFromEnv(env)).toEqual({
        provider: "anthropic",
        keyVar: "ANTHROPIC_API_KEY",
        models: MODEL_IDS,
        recordedModels: MODEL_IDS,
      });
    }
  });

  it("uses OpenRouter's Claude models by default and records the provider with each id", () => {
    expect(llmConfigFromEnv({ LLM_PROVIDER: "openrouter" })).toEqual({
      provider: "openrouter",
      keyVar: "OPENROUTER_API_KEY",
      models: { reasoning: "anthropic/claude-sonnet-5.5", fast: "anthropic/claude-haiku-5.5" },
      recordedModels: { reasoning: "openrouter:anthropic/claude-sonnet-5.5", fast: "openrouter:anthropic/claude-haiku-5.5" },
    });
    expect(OPENROUTER_DEFAULT_MODELS.reasoning).toBe("anthropic/claude-sonnet-5.5");
  });

  it("takes OpenRouter model overrides (blank means default)", () => {
    const cfg = llmConfigFromEnv({ LLM_PROVIDER: "openrouter", OPENROUTER_MODEL_REASONING: " google/gemini-3.8-flash ", OPENROUTER_MODEL_FAST: "" });
    expect(cfg.models).toEqual({ reasoning: "google/gemini-3.8-flash", fast: "anthropic/claude-haiku-5.5" });
    expect(cfg.recordedModels.reasoning).toBe("openrouter:google/gemini-3.8-flash");
  });

  it("ignores OpenRouter model overrides when the provider is Anthropic", () => {
    expect(llmConfigFromEnv({ OPENROUTER_MODEL_REASONING: "google/gemini-3.8-flash" }).models).toEqual(MODEL_IDS);
  });

  it("rejects an unknown provider with a readable message", () => {
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: "openai" })).toThrow('LLM_PROVIDER must be "anthropic" or "openrouter" (got "openai").');
  });
});
