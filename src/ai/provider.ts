import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";

export function createModel(config: Config): LanguageModel {
  const openrouter = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
  });
  return openrouter(config.OPENROUTER_MODEL);
}
