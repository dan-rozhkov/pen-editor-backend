import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";

export function createModel(
  config: Config,
  overrideProvider?: "anthropic" | "openai",
): LanguageModel {
  const provider = overrideProvider ?? config.AI_PROVIDER;

  if (provider === "anthropic") {
    const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_API_KEY });
    return anthropic(config.ANTHROPIC_MODEL);
  }

  const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
  return openai(config.OPENAI_MODEL);
}
