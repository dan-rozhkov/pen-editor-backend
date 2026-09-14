import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import type { Config } from "../config.js";

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

export type ModelProviderId = "deepseek" | "openrouter";

export interface ModelRef {
  provider: ModelProviderId;
  modelId: string;
}

// The only prefixes parseModelRef recognizes. Deliberately NOT a blind
// `ref.split(":")[0]` — OpenRouter model ids themselves routinely contain a
// colon (e.g. "openai/gpt-4o:extended", "meta/llama:free" for a
// provider-specific variant suffix), so splitting on the first colon would
// chop a legitimate OpenRouter id in half and silently misroute or corrupt
// it. Recognizing only these two exact prefixes means any colon appearing
// later in the string (as in those examples) is left alone and stays part
// of modelId.
const KNOWN_PROVIDER_PREFIXES: ModelProviderId[] = ["deepseek", "openrouter"];

// Parses a model reference of the form "<provider>:<modelId>". A string with
// no recognized prefix (including one with an unrelated colon in it, like
// "openai/gpt-4o:extended") is treated as a LEGACY bare OpenRouter id — the
// whole string becomes modelId and provider defaults to "openrouter". This
// legacy path exists so already-deployed env values (Render's CHAT_MODEL,
// formerly OPENROUTER_MODEL) and CLI overrides like
// `npm run showcase:generate -- --model=google/gemini-3.7-flash` keep
// working unchanged after this provider split landed.
export function parseModelRef(ref: string): ModelRef {
  for (const provider of KNOWN_PROVIDER_PREFIXES) {
    const prefix = `${provider}:`;
    if (ref.startsWith(prefix)) {
      return { provider, modelId: ref.slice(prefix.length) };
    }
  }
  return { provider: "openrouter", modelId: ref };
}

// Whether `provider`'s AI SDK integration can carry an IMAGE found inside a
// tool-result part (e.g. get_screenshot's output) through to the model as a
// real image, as opposed to flattening it into a giant base64 JSON string
// inside a plain text tool message.
//
// Verified directly against each provider's installed source (both handle
// ToolResultPart["output"].type === "content", the shape get_screenshot
// returns):
//   - @openrouter/ai-sdk-provider (node_modules/@openrouter/ai-sdk-provider/
//     dist/index.js:3142-3151, mapToolResultContentParts): an "image-data"
//     part becomes a real `{type: "image_url", image_url: {...}}` chat
//     content part.
//   - @ai-sdk/deepseek (node_modules/@ai-sdk/deepseek/dist/index.js:387-390):
//     the "content" case falls into `contentValue = JSON.stringify(output.
//     value)`, which serializes the image-data part (base64 payload
//     included) as text and sends THAT as the tool message's string content.
//     There is no branch that promotes it to an image part.
//
// This says nothing about images in USER messages — DeepSeek reads those
// natively (see deepseekFilePartProviderOptions.imageDetail). It is
// specifically about the tool-result path, which is why
// src/ai/vision-messages.ts consults it separately from modelSupportsVision.
export function providerHandlesToolResultImages(provider: ModelProviderId): boolean {
  return provider === "openrouter";
}

// The bare model id — with any recognized provider prefix stripped — that
// must be the only thing that ever reaches a client, a log line, or a
// database column. The provider prefix is an internal routing detail of
// createModel and must never leak into GET /api/models, raw_traces,
// showcase_screens.model, etc.
export function bareModelId(ref: string): string {
  return parseModelRef(ref).modelId;
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
