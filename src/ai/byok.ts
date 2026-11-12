// BYOK custom OpenAI-compatible provider: the user's own Base URL, key and
// model id (docs/specs/2026-11-13-byok-custom-provider-design.md).

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createByokFetch } from "./byokNetwork.js";

export interface CreateByokModelOptions {
  /** Already validated by parseByokBaseUrl. */
  baseUrl: string;
  /** The calling user's own key. */
  apiKey: string;
  /** What the user's provider calls the model (prefix "byok/" already removed). */
  modelId: string;
  allowPrivateNetwork: boolean;
  /** Test seam; defaults to the SSRF-guarded fetch. */
  fetch?: typeof globalThis.fetch;
}

export function createByokModel(options: CreateByokModelOptions): LanguageModel {
  const provider = createOpenAICompatible({
    name: "byok",
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
    fetch: options.fetch ?? createByokFetch({ allowPrivateNetwork: options.allowPrivateNetwork }),
    // Without it no usage block arrives and raw_traces records zero tokens
    // (same reason as src/ai/opencode.ts).
    includeUsage: true,
  });
  return provider.chatModel(options.modelId);
}
