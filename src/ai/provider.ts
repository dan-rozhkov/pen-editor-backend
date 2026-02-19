import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";

export function createModel(config: Config, modelOverride?: string): LanguageModel {
  const openrouter = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
  });
  const modelId = modelOverride ?? config.OPENROUTER_MODEL;
  const reasoningPrefixes = ["anthropic/", "moonshotai/", "minimax/", "qwen/", "z-ai/"];
  const supportsReasoning = reasoningPrefixes.some((p) => modelId.startsWith(p));
  return openrouter(modelId, supportsReasoning ? {
    reasoning: { effort: "medium" },
  } : undefined);
}
