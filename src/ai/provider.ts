import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import type { Config } from "../config.js";
import { parseModelRef } from "./modelRef.js";

// Re-exported so existing importers of these helpers keep working and so
// there is one obvious place to look for them; the definitions live in
// ./modelRef.ts, which must stay import-free (see its header).
export {
  parseModelRef,
  bareModelId,
  providerHandlesToolResultImages,
  type ModelRef,
  type ModelProviderId,
} from "./modelRef.js";

// This allowlist exists so `reasoning` is only ever sent to model families
// that actually support reasoning control — an id whose family isn't listed
// here silently gets NO reasoning cap regardless of
// CHAT_REASONING_EFFORT, which is exactly how the agent ended up
// sitting in open-ended "thinking" before every reply: this list had drifted
// out of sync with config.ts's CHAT_MODEL default. The shipped CHAT_MODEL
// default is asserted against this list (when it resolves to the OpenRouter
// branch — the DeepSeek-direct branch has its own, allowlist-free gate, see
// below) by test/provider-routing.test.ts's "default CHAT_MODEL reasoning
// coverage gate", so drift fails CI instead of just quietly costing latency
// again. (test/provider-reasoning.test.ts covers this same allowlist against
// fixed, representative ids — not the live default, which moved to the
// DeepSeek-direct branch and is out of scope there.)
//
// This list is only consulted on the OpenRouter branch of createModel below
// — the DeepSeek-direct branch (CHAT_MODEL prefixed "deepseek:") has its own
// reasoning wiring via providerOptions.deepseek, see mapReasoningEffort.
//
// What a listed family actually DOES with the value differs and is only
// verified for deepseek/* (see config.ts's CHAT_REASONING_EFFORT
// comment for the live measurement): there, `effort` gradations
// (minimal/low/.../high) and `reasoning.max_tokens` are both ignored — the
// only value that suppresses reasoning at all is "none". Other families in
// this list have not been measured the same way; don't assume they behave
// like deepseek or like each other.
//
// CHAT_REASONING_EFFORT itself is only applied to the main chat model
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

// DeepSeek's `thinking` option defaults to "enabled" when omitted — sending
// no providerOptions at all would silently turn reasoning back on for every
// request, exactly the regression commit 9719e79 fixed for the OpenRouter
// path (see config.ts's CHAT_REASONING_EFFORT comment for the live
// measurement backing its "none" default). So the DeepSeek branch below
// ALWAYS sends an explicit `thinking`, never empty options.
//
// DeepSeek's own reasoningEffort enum ("low" | "high" | "max") is coarser
// than CHAT_REASONING_EFFORT's six-value scale, so values compress:
//   none               -> thinking disabled, no reasoningEffort sent
//   minimal, low       -> thinking enabled, reasoningEffort "low"
//   medium, high       -> thinking enabled, reasoningEffort "high"
//   xhigh              -> thinking enabled, reasoningEffort "max"
// DeepSeek has no equivalent of "minimal"/"medium"/"xhigh" directly, hence
// the compression onto the nearest rung it does support (xhigh maps to
// "max" since it's the most-reasoning end of the scale).
function mapReasoningEffort(
  effort: Config["CHAT_REASONING_EFFORT"],
): { thinking: { type: "enabled" | "disabled" }; reasoningEffort?: "low" | "high" | "max" } {
  switch (effort) {
    case "none":
      return { thinking: { type: "disabled" } };
    case "minimal":
    case "low":
      return { thinking: { type: "enabled" }, reasoningEffort: "low" };
    case "medium":
    case "high":
      return { thinking: { type: "enabled" }, reasoningEffort: "high" };
    case "xhigh":
      return { thinking: { type: "enabled" }, reasoningEffort: "max" };
  }
}

export function createModel(
  config: Config,
  modelOverride?: string,
): LanguageModel {
  const ref = parseModelRef(modelOverride ?? config.CHAT_MODEL);

  if (ref.provider === "deepseek") {
    const deepseek = createDeepSeek({ apiKey: config.DEEPSEEK_API_KEY });
    // CHAT_REASONING_EFFORT (like the OpenRouter branch's `reasoning` below)
    // is scoped to the main chat model only — a call with modelOverride is a
    // helper role (ANALYSIS_MODEL, VISION_MODEL, selfimprove review, user
    // skills, prototype-link) that keeps the pre-existing "minimal" effort
    // regardless of the chat knob, same as the OpenRouter branch.
    const effort = modelOverride === undefined ? config.CHAT_REASONING_EFFORT : "minimal";
    return wrapLanguageModel({
      model: deepseek(ref.modelId),
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { deepseek: mapReasoningEffort(effort) } },
      }),
    });
  }

  const openrouter = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
  });
  const modelId = ref.modelId;
  if (!supportsReasoningControl(modelId)) {
    return openrouter(modelId);
  }
  // CHAT_REASONING_EFFORT (and the live measurement backing its "none"
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
    return openrouter(modelId, { reasoning: { effort: config.CHAT_REASONING_EFFORT } });
  }
  return openrouter(modelId, { reasoning: { effort: "minimal" } });
}
