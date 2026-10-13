import type { Config } from "../config.js";
import { createSystemOneClient } from "@sideform/browser-agent/adapters/systemone-http";

// Thin wrapper over the package's System One (Jev) client. The vendor
// contract, retries, error classes and model predicates live in
// @sideform/browser-agent; this file only maps Config onto the client options
// and keeps the old import path for the backend's callers (taste check, skill
// routing, trace analysis, browse routes).

export { OPENROUTER_DECISIONS_BASE_URL } from "@sideform/browser-agent/adapters/systemone-http";
export {
  isJevModel,
  isOpenAIDecisions,
  SystemOneAuthError,
  SystemOneError,
  SystemOneRateLimitError,
  SystemOneRefusalError,
  SystemOneUpstreamError,
  SystemOneValidationError,
} from "@sideform/browser-agent/policy";
export type {
  SystemOneAnswer,
  SystemOneAnswers,
  SystemOneChoiceAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneInstructions,
  SystemOneNoulAnswer,
  SystemOneQuestion,
  SystemOneResult,
  SystemOneScoreAnswer,
} from "@sideform/browser-agent/policy";

import type { SystemOneClient } from "@sideform/browser-agent/policy";

/** null when TYPESAFE_API_KEY is unset: the feature is off. */
export function createSystemOne(
  config: Config,
  fetchFn: typeof fetch = fetch,
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>,
): SystemOneClient | null {
  if (!config.TYPESAFE_API_KEY) return null;
  return createSystemOneClient({
    apiKey: config.TYPESAFE_API_KEY,
    model: config.TYPESAFE_MODEL,
    baseUrl: config.TYPESAFE_BASE_URL,
    openRouterApiKey: config.OPENROUTER_API_KEY,
    fetch: fetchFn,
    sleep: sleepFn,
  });
}
