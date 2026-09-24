import { randomUUID } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, wrapLanguageModel } from "ai";
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
   * Explicit reasoning effort for a latency-critical helper call, overriding
   * the chat/helper split resolveReasoningEffort makes. The browse_task step
   * route uses "none": STRUCTURED_MODEL (deepseek-v4.1-flash) ignores every
   * gradation except "none" (see deepseek-reasoning-effort-is-noop), so the
   * helper default "minimal" meant a full reasoning budget — measured
   * 2026-09-24, the step cascade hit its 8 s timeout on every call.
   */
  reasoningEffort?: Config["CHAT_REASONING_EFFORT"] | "minimal";

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

/**
 * Which reasoning effort a given call gets. Its own function because
 * createModel's OpenRouter branch now returns a *wrapped* model (see
 * withReasoningMandatoryFallback), so the effort is no longer readable off
 * the returned object's `settings` — and reaching into a third-party
 * model's internals was never a contract worth pinning anyway. This is the
 * decision itself, which is what the tests actually care about.
 *
 * CHAT_REASONING_EFFORT (and the live measurement backing its "none"
 * default in config.ts) was only ever measured for the chat agent. Callers
 * that pass a modelOverride WITHOUT `chatAgent` are a different job
 * (ANALYSIS_MODEL in src/analysis/run.ts, VISION_MODEL in
 * src/services/vision.ts, src/ai/selfimprove/review.ts,
 * src/routes/userSkills.ts, src/ai/prototype-link.ts): analysis/review work
 * benefits from actual reasoning, so gating those to the chat-tuned "none"
 * default would silently regress them. Keep those on the pre-existing
 * "minimal" behavior instead of threading the operator knob through.
 */
export function resolveReasoningEffort(
  config: Config,
  modelOverride?: string,
  chatAgent?: boolean,
  explicit?: Config["CHAT_REASONING_EFFORT"] | "minimal",
): Config["CHAT_REASONING_EFFORT"] | "minimal" {
  if (explicit !== undefined) return explicit;
  return modelOverride === undefined || chatAgent
    ? config.CHAT_REASONING_EFFORT
    : "minimal";
}

/**
 * OpenRouter answers 400 "Reasoning is mandatory for this endpoint and
 * cannot be disabled" for models that require reasoning — it does NOT
 * quietly drop the parameter. REASONING_MODEL_PREFIXES lists whole
 * families on the assumption that "OpenRouter normalizes `reasoning` and
 * drops it for a model that can't use it, so the cost of that is nothing";
 * that holds for a model with no reasoning, and is false for one that
 * mandates it.
 *
 * Measured 2026-09-18 against the live API with `effort: "none"` (the
 * CHAT_REASONING_EFFORT default): 4 of the 10 selectable OpenRouter models
 * in DEFAULT_MODELS answered 400 — meta/muse-spark-1.3-contributor,
 * z-ai/glm-5.3-flash, google/gemini-3.8-flash and z-ai/glm-5.3. Picking any
 * of them in the composer failed every single turn with a bare "An error
 * occurred".
 *
 * Handled as a retry rather than a denylist on purpose: which models
 * mandate reasoning is the vendor's decision and changes without notice, so
 * a hardcoded list would be wrong again by the next model refresh. The
 * error is specific enough to match, the retry runs at most once, and
 * anything that isn't this exact failure is rethrown untouched.
 */
function isReasoningMandatoryError(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false;
  if (err.statusCode !== 400) return false;
  const body = typeof err.responseBody === "string" ? err.responseBody : "";
  return /reasoning is mandatory/i.test(`${err.message} ${body}`);
}

/** Wraps `primary` so the one failure above retries once against a model
 * built with no `reasoning` option at all. `params` is reused verbatim, so
 * the retry differs from the original request only by that option. */
function withReasoningMandatoryFallback(
  primary: LanguageModel,
  buildWithoutReasoning: () => LanguageModel,
): LanguageModel {
  const model = primary as Parameters<typeof wrapLanguageModel>[0]["model"];
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return await doGenerate();
        } catch (err) {
          if (!isReasoningMandatoryError(err)) throw err;
          const fallback = buildWithoutReasoning() as typeof model;
          return fallback.doGenerate(params);
        }
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (err) {
          if (!isReasoningMandatoryError(err)) throw err;
          const fallback = buildWithoutReasoning() as typeof model;
          return fallback.doStream(params);
        }
      },
    },
  }) as LanguageModel;
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
  // See resolveReasoningEffort's own doc comment for why a modelOverride
  // without `chatAgent` deliberately stays on "minimal".
  const effort = resolveReasoningEffort(
    config,
    modelOverride,
    options.chatAgent,
    options.reasoningEffort,
  );
  return withReasoningMandatoryFallback(
    openrouter(modelId, { reasoning: { effort } }),
    () => openrouter(modelId),
  );
}
