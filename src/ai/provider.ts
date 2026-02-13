import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";

export function createModel(config: Config): LanguageModel {
  const openai = createOpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.OPENAI_BASE_URL,
  });
  return openai(config.OPENAI_MODEL);
}
