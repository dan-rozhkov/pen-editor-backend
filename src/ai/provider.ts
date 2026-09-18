import { randomUUID } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";
import { parseModelRef, isOpenCodeProvider } from "./modelRef.js";
import { createOpenCodeModel } from "./opencode.js";

// Re-exported so existing importers of these helpers keep working and so
// there is one obvious place to look for them; the definitions live in
// ./modelRef.ts, which must stay import-free (see its header).
export {
  parseModelRef,
  bareModelId,
  providerHandlesToolResultImages,
  isOpenCodeProvider,
  type ModelRef,
  type ModelProviderId,
} from "./modelRef.js";

// This allowlist exists so `reasoning` is only ever sent to model families
// that actually support reasoning control — an id whose family isn't listed
// here silently gets NO reasoning cap regardless of CHAT_REASONING_EFFORT,
// which is exactly how the agent ended up sitting in open-ended "thinking"
// before every reply: this list had drifted out of sync with config.ts's
// chat-model default. Every id in DEFAULT_MODELS (config.ts) is asserted
// against this list by test/provider-routing.test.ts's "selectable models
// reasoning coverage gate", so drift fails CI instead of just quietly
// costing latency again. (test/provider-reasoning.test.ts covers the same
// allowlist against fixed, representative ids.)
//
// What a listed family actually DOES with the value differs and is only
// verified for deepseek/* (see config.ts's CHAT_REASONING_EFFORT comment for
// the live measurement): there, `effort` gradations (minimal/low/.../high)
// and `reasoning.max_tokens` are both ignored — the only value that
// suppresses reasoning at all is "none". Other families in this list have
// not been measured the same way; don't assume they behave like deepseek or
// like each other.
//
// CHAT_REASONING_EFFORT itself is only applied to the main chat model
// (createModel(config) with no modelOverride) — see createModel below for
// why calls with a modelOverride (analysis/vision/review/etc.) don't use it.
export const REASONING_MODEL_PREFIXES = [
  "anthropic/",
  "moonshotai/",
  "minimax/",
  "qwen/",
  "meta/",
  "xiaomi/",
  "z-ai/",
  "x-ai/",
  "nvidia/",
  "deepseek/",
  // Added 2026-09-17 alongside the six models appended to DEFAULT_MODELS.
  // These are whole-FAMILY prefixes, so they also cover older siblings that
  // have no reasoning of their own (openai/gpt-4o-mini, say) — OpenRouter
  // normalizes `reasoning` and drops it for a model that can't use it, so
  // the cost of that is nothing, while leaving a family off costs the
  // uncapped open-ended thinking this list exists to prevent.
  "stealth/",
  "google/",
  "tencent/",
  "openai/",
];

export function supportsReasoningControl(modelId: string): boolean {
  return REASONING_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export interface CreateModelOptions {
  /**
   * True when this model IS the chat agent for a turn — the /api/chat route
   * and the showcase runner — even though a model id is being passed
   * explicitly (the composer's picker, or `showcase:generate --model=`).
   * Such a call gets CHAT_REASONING_EFFORT like the no-override chat model
   * does; without it, restoring the model picker would silently move every
   * user who picks a model off the operator's measured "none" onto the
   * helper-role "minimal", because a selection is indistinguishable from an
   * ANALYSIS_MODEL/VISION_MODEL-style override at this boundary.
   */
  chatAgent?: boolean;

  /**
   * Stable id for the current conversation, sent upstream as OpenCode's
   * `x-opencode-session` header (see src/ai/opencode.ts). Only meaningful
   * when the resolved provider is an OpenCode route; ignored for OpenRouter.
   */
  sessionId?: string;

  /**
   * The CALLING USER'S OWN OpenCode API key (never a server-side key — none
   * exists for OpenCode in this product, see
   * docs/specs/2026-09-18-opencode-byok-design.md). Only meaningful when the
   * resolved provider is an OpenCode route.
   */
  opencodeApiKey?: string;
}

export function createModel(
  config: Config,
  modelOverride?: string,
  options: CreateModelOptions = {},
): LanguageModel {
  const ref = parseModelRef(modelOverride ?? config.CHAT_MODEL);

  if (isOpenCodeProvider(ref.provider)) {
    if (!options.opencodeApiKey || !options.opencodeApiKey.trim()) {
      throw new Error(
        `Model provider "${ref.provider}" requires the calling user's own ` +
          "OpenCode API key (opencodeApiKey) — there is no server-side " +
          "OpenCode key in this product, unlike OPENROUTER_API_KEY.",
      );
    }
    // A stable id is generated when the caller doesn't supply one, rather
    // than omitting the x-opencode-session header entirely: OpenCode's Go
    // docs say this header drives THEIR routing and prompt-cache behavior,
    // and this codebase treats prompt-cache stability as a load-bearing
    // invariant elsewhere (see modelRef.ts's header and
    // docs/superpowers/specs/2026-08-*-prompt-cache*). A missing/rotating
    // session id would deny OpenCode's own cache the same stable prefix we
    // go out of our way to preserve for OpenRouter.
    const sessionId = options.sessionId ?? randomUUID();
    // CHAT_REASONING_EFFORT / {reasoning: {effort}} is an OpenRouter-shaped
    // option (see supportsReasoningControl below) and must NEVER be sent to
    // OpenCode's /chat/completions client — this branch does not touch
    // reasoning at all, deliberately.
    return createOpenCodeModel({
      // isOpenCodeProvider(ref.provider) above already narrowed this to
      // "opencode" | "opencode-go" at runtime; it isn't a TS type predicate
      // (defined in modelRef.ts, which this task must not edit), so the
      // narrowing is asserted here instead of inferred.
      provider: ref.provider as "opencode" | "opencode-go",
      modelId: ref.modelId,
      apiKey: options.opencodeApiKey,
      sessionId,
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
  // default in config.ts) was only ever measured for the chat agent.
  // Callers that pass a modelOverride WITHOUT `chatAgent` are a different
  // job (ANALYSIS_MODEL in src/analysis/run.ts, VISION_MODEL in
  // src/services/vision.ts, src/ai/selfimprove/review.ts,
  // src/routes/userSkills.ts, src/ai/prototype-link.ts): analysis/review
  // work benefits from actual reasoning, so gating those to the chat-tuned
  // "none" default would silently regress them. Keep those on the
  // pre-existing "minimal" behavior instead of threading the operator knob
  // through to them.
  const effort =
    modelOverride === undefined || options.chatAgent
      ? config.CHAT_REASONING_EFFORT
      : "minimal";
  return openrouter(modelId, { reasoning: { effort } });
}
