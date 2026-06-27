import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";

export function createModel(
  config: Config,
  modelOverride?: string,
): LanguageModel {
  const openrouter = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
  });
  const modelId = modelOverride ?? config.OPENROUTER_MODEL;
  const reasoningPrefixes = [
    "anthropic/",
    "moonshotai/",
    "minimax/",
    "qwen/",
    "xiaomi/",
    "z-ai/",
    "x-ai/",
    "nvidia/",
  ];
  const supportsReasoning = reasoningPrefixes.some((p) =>
    modelId.startsWith(p),
  );
  return openrouter(
    modelId,
    supportsReasoning
      ? {
          // Trim how long the agent "thinks" before answering. "minimal" keeps
          // reasoning enabled (unlike "none") but one notch below "low".
          reasoning: { effort: "minimal" },
        }
      : undefined,
  );
}
