// BYOK custom OpenAI-compatible provider: the user's own Base URL, key and
// model id (docs/specs/2026-11-13-byok-custom-provider-design.md).

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createByokFetch } from "./byokNetwork.js";
import { moveToolResultImagesToUserMessage } from "./opencode.js";

export interface CreateByokModelOptions {
  /** Already validated by parseByokBaseUrl. */
  baseUrl: string;
  /** The calling user's own key. */
  apiKey: string;
  /** What the user's provider calls the model (prefix "byok/" already removed). */
  modelId: string;
  allowPrivateNetwork: boolean;
  /**
   * Images inside tool results (the AI SDK stringifies them for
   * openai-compatible) move into a user message after the tool message(s):
   * OpenAI chat completions accept only text in role:"tool". Local mode only:
   * there the user's model gets screenshots.
   */
  restoreToolImages?: boolean;
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
    ...(options.restoreToolImages ? { transformRequestBody: moveToolResultImagesToUserMessage } : {}),
  });
  return provider.chatModel(options.modelId);
}
