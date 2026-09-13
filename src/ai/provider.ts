import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";

// This allowlist exists so `reasoning` is only ever sent to model families
// that actually support reasoning control — an id whose family isn't listed
// here silently gets NO reasoning cap regardless of
// OPENROUTER_REASONING_EFFORT, which is exactly how the agent ended up
// sitting in open-ended "thinking" before every reply: this list had drifted
// out of sync with config.ts's OPENROUTER_MODEL default. The default model
// is asserted against this list in test/provider-reasoning.test.ts so that
// drift fails CI instead of just quietly costing latency again.
//
// What a listed family actually DOES with the value differs and is only
// verified for deepseek/* (see config.ts's OPENROUTER_REASONING_EFFORT
// comment for the live measurement): there, `effort` gradations
// (minimal/low/.../high) and `reasoning.max_tokens` are both ignored — the
// only value that suppresses reasoning at all is "none". Other families in
// this list have not been measured the same way; don't assume they behave
// like deepseek or like each other.
//
// OPENROUTER_REASONING_EFFORT itself is only applied to the main chat model
// (createModel(config) with no modelOverride) — see createModel below for
// why calls with a modelOverride (analysis/vision/review/etc.) don't use it.
export const REASONING_MODEL_PREFIXES = [
  "anthropic/",
  "moonshotai/",
  "minimax/",
  "qwen/",
  "xiaomi/",
  "z-ai/",
  "x-ai/",
  "nvidia/",
  "deepseek/",
];

export function supportsReasoningControl(modelId: string): boolean {
  return REASONING_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export function createModel(
  config: Config,
  modelOverride?: string,
): LanguageModel {
  const openrouter = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
  });
  const modelId = modelOverride ?? config.OPENROUTER_MODEL;
  if (!supportsReasoningControl(modelId)) {
    return openrouter(modelId);
  }
  // OPENROUTER_REASONING_EFFORT (and the live measurement backing its "none"
  // default in config.ts) was only ever measured for the main chat model —
  // the plain `createModel(config)` call with no override, used by the
  // /api/chat route. Callers that pass modelOverride are a different job
  // (ANALYSIS_MODEL in src/analysis/run.ts, VISION_MODEL in
  // src/services/vision.ts, src/ai/selfimprove/review.ts,
  // src/routes/userSkills.ts, src/ai/prototype-link.ts): analysis/review
  // work benefits from actual reasoning, so gating those to the chat-tuned
  // "none" default would silently regress them. Keep those on the
  // pre-existing "minimal" behavior instead of threading the operator knob
  // through to them.
  if (modelOverride === undefined) {
    return openrouter(modelId, { reasoning: { effort: config.OPENROUTER_REASONING_EFFORT } });
  }
  return openrouter(modelId, { reasoning: { effort: "minimal" } });
}
