import { describe, expect, it } from "vitest";
import {
  createModel,
  resolveReasoningEffort,
  supportsReasoningControl,
} from "../src/ai/provider.js";
import { envSchema } from "../src/config.js";
import { makeConfig } from "./helpers.js";

// The real regression this file guards against: a model id drifting to a
// family outside REASONING_MODEL_PREFIXES, which silently disables all
// reasoning control for it (see provider.ts's comment for how that happened
// with deepseek/*). A fixed representative id here; every SELECTABLE model
// (DEFAULT_MODELS) and the shipped CHAT_MODEL default are gated separately
// in test/provider-routing.test.ts.
const OPENROUTER_STYLE_DEEPSEEK_ID = "deepseek/deepseek-v4.1-flash";

// Same idea for the effort value itself: read the schema's real default
// rather than hardcoding "none", so a silent revert to the old (measured
// broken, for deepseek) "minimal" default fails this test instead of
// sailing through unnoticed.
function defaultReasoningEffort(): string {
  return envSchema.shape.CHAT_REASONING_EFFORT.parse(undefined);
}

describe("supportsReasoningControl", () => {
  it("covers OpenRouter's deepseek/* naming", () => {
    expect(supportsReasoningControl(OPENROUTER_STYLE_DEEPSEEK_ID)).toBe(true);
  });

  // Fixed, representative ids rather than iterating REASONING_MODEL_PREFIXES
  // itself — that would make this test tautological (supportsReasoningControl
  // is `some(startsWith)` over that same array, so it could never fail here,
  // not even if the list were emptied out). These ids pin actual behavior.
  it("returns true for representative allowlisted model ids", () => {
    for (const modelId of [
      "anthropic/claude-opus-5",
      "x-ai/grok-4",
      "deepseek/deepseek-v4.1-flash",
      "qwen/qwen3-max",
      "moonshotai/kimi-k2",
      "minimax/minimax-m3",
      "z-ai/glm-4.6",
      "nvidia/nemotron-4",
      "xiaomi/mimo-7b",
      "stealth/union-alpha",
      "google/gemini-3.8-flash",
      "tencent/hy4-preview",
      "openai/gpt-6-luna",
    ]) {
      expect(supportsReasoningControl(modelId)).toBe(true);
    }
  });

  it("returns false for a model family outside the allowlist", () => {
    expect(supportsReasoningControl("mistralai/mistral-large")).toBe(false);
  });
});

describe("CHAT_REASONING_EFFORT default", () => {
  // Live-measured (real OpenRouter calls against deepseek/deepseek-v4.1-
  // flash, 2026-09): "minimal" and "high" produced identical, budget-capped
  // reasoning — deepseek ignores effort gradations over OpenRouter — and
  // only "none" actually suppressed reasoning. This is the gate against
  // silently reverting to the old, measured-ineffective "minimal" default.
  it("is 'none'", () => {
    expect(defaultReasoningEffort()).toBe("none");
  });
});

describe("createModel reasoning effort", () => {
  // These assert the EFFORT DECISION rather than the returned model's
  // `settings`: createModel's OpenRouter branch now returns a model wrapped
  // by withReasoningMandatoryFallback, so the provider object's internals
  // are no longer reachable — and reaching into them was never the contract
  // worth pinning. resolveReasoningEffort is that decision, exported for
  // exactly this.
  it("passes the configured effort through for the chat model", () => {
    const config = makeConfig({
      CHAT_MODEL: OPENROUTER_STYLE_DEEPSEEK_ID,
      CHAT_REASONING_EFFORT: "high",
    });
    expect(resolveReasoningEffort(config, undefined, undefined)).toBe("high");
  });

  it("defaults to 'none' when the config value is left at its schema default", () => {
    const config = makeConfig({
      CHAT_MODEL: OPENROUTER_STYLE_DEEPSEEK_ID,
      CHAT_REASONING_EFFORT: defaultReasoningEffort() as "none",
    });
    expect(resolveReasoningEffort(config, undefined, undefined)).toBe("none");
  });

  it("omits reasoning settings for a model family outside the allowlist", () => {
    const config = makeConfig({ CHAT_MODEL: "mistralai/mistral-large" });
    const model = createModel(config) as unknown as {
      settings: { reasoning?: { effort?: string } };
    };
    expect(model.settings.reasoning).toBeUndefined();
  });

  // The operator-tunable CHAT_REASONING_EFFORT (default "none") is
  // scoped to the main chat model only — createModel(config) with no
  // modelOverride. A call with modelOverride is a helper role (analysis,
  // vision, selfimprove review, user skills, prototype-link) that was never
  // part of the "none" measurement and should keep the pre-existing
  // "minimal" effort regardless of what the chat knob is set to.
  it("scopes CHAT_REASONING_EFFORT to the chat model, not modelOverride calls", () => {
    const config = makeConfig({
      CHAT_MODEL: OPENROUTER_STYLE_DEEPSEEK_ID,
      CHAT_REASONING_EFFORT: "high",
    });

    expect(resolveReasoningEffort(config, undefined, undefined)).toBe("high");
    expect(
      resolveReasoningEffort(config, OPENROUTER_STYLE_DEEPSEEK_ID, undefined),
    ).toBe("minimal");
  });
  // The one exception to the rule above: the chat agent itself, on a turn
  // where the model was chosen per request (the composer's picker, or
  // `showcase:generate --model=`). That reaches createModel as an override
  // too, but it IS the chat model — without `chatAgent`, restoring the
  // picker would silently move every user who picks a model off the
  // operator's measured "none" onto "minimal".
  it("applies CHAT_REASONING_EFFORT to a per-request chat model", () => {
    const config = makeConfig({
      CHAT_MODEL: OPENROUTER_STYLE_DEEPSEEK_ID,
      CHAT_REASONING_EFFORT: "none",
    });
    expect(resolveReasoningEffort(config, "qwen/qwen3.8-flash", true)).toBe("none");
  });
});
