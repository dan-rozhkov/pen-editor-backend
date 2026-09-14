import { describe, expect, it, vi } from "vitest";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { envSchema } from "../src/config.js";
import { makeConfig } from "./helpers.js";

// The underlying @ai-sdk/deepseek model is mocked so these tests never make a
// real network call — they only assert what createModel/defaultSettingsMiddleware
// hand the underlying model's doGenerate/doStream, which is the real request
// body DeepSeek would receive (providerOptions.deepseek), not a re-statement
// of provider.ts's own source.
const deepseekCalls: { modelId: string }[] = [];
let lastDeepseekParams: LanguageModelV3CallOptions | undefined;

function makeFakeDeepseekModel(modelId: string): LanguageModelV3 {
  deepseekCalls.push({ modelId });
  return {
    specificationVersion: "v3",
    provider: "deepseek.chat",
    modelId,
    supportedUrls: {},
    async doGenerate(params: LanguageModelV3CallOptions) {
      lastDeepseekParams = params;
      return {
        content: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      } as unknown as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
    },
    async doStream(params: LanguageModelV3CallOptions) {
      lastDeepseekParams = params;
      return {
        stream: new ReadableStream(),
        warnings: [],
      } as unknown as Awaited<ReturnType<LanguageModelV3["doStream"]>>;
    },
  } as LanguageModelV3;
}

vi.mock("@ai-sdk/deepseek", () => ({
  createDeepSeek: vi.fn(() => (modelId: string) => makeFakeDeepseekModel(modelId)),
}));

const { createModel, parseModelRef, bareModelId, supportsReasoningControl } = await import(
  "../src/ai/provider.js"
);

describe("parseModelRef", () => {
  it("recognizes the deepseek: prefix", () => {
    expect(parseModelRef("deepseek:deepseek-flash")).toEqual({
      provider: "deepseek",
      modelId: "deepseek-flash",
    });
  });

  it("recognizes the openrouter: prefix", () => {
    expect(parseModelRef("openrouter:google/gemini-2.5-flash")).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
  });

  // The whole reason a prefix allowlist is used instead of a blind
  // `ref.split(":")` — a real OpenRouter id can carry its own colon (a
  // provider-specific variant suffix), and that colon must NOT be mistaken
  // for a provider-prefix separator.
  it("does not mistake a colon inside a legacy OpenRouter id for a provider prefix", () => {
    expect(parseModelRef("openai/gpt-4o:extended")).toEqual({
      provider: "openrouter",
      modelId: "openai/gpt-4o:extended",
    });
    expect(parseModelRef("meta/llama:free")).toEqual({
      provider: "openrouter",
      modelId: "meta/llama:free",
    });
  });

  // A bare string with no recognized prefix at all is the legacy path: the
  // whole string is the modelId and the provider defaults to openrouter.
  // This keeps already-deployed env values and
  // `--model=google/gemini-3.7-flash` CLI overrides working unchanged.
  it("treats an unprefixed string as a legacy bare OpenRouter id", () => {
    expect(parseModelRef("google/gemini-3.7-flash")).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.7-flash",
    });
  });
});

describe("bareModelId", () => {
  it("strips a recognized provider prefix", () => {
    expect(bareModelId("deepseek:deepseek-flash")).toBe("deepseek-flash");
    expect(bareModelId("openrouter:google/gemini-2.5-flash")).toBe(
      "google/gemini-2.5-flash",
    );
  });

  it("returns a legacy bare id unchanged", () => {
    expect(bareModelId("google/gemini-3.7-flash")).toBe("google/gemini-3.7-flash");
  });
});

describe("createModel provider routing", () => {
  it("routes a deepseek: prefixed CHAT_MODEL to the DeepSeek provider", async () => {
    const config = makeConfig({
      CHAT_MODEL: "deepseek:deepseek-flash",
      DEEPSEEK_API_KEY: "test-deepseek-key",
    });
    const model = createModel(config);
    expect(model.provider).toBe("deepseek.chat");
    expect(model.modelId).toBe("deepseek-flash");
  });

  it("routes an openrouter: prefixed CHAT_MODEL to OpenRouter", () => {
    const config = makeConfig({ CHAT_MODEL: "openrouter:google/gemini-2.5-flash" });
    const model = createModel(config) as unknown as { modelId?: string };
    // The real (unmocked) @openrouter/ai-sdk-provider factory exposes the
    // bare model id it was constructed with — no network call happens
    // building this object.
    expect(model.modelId).toBe("google/gemini-2.5-flash");
  });

  // The legacy path: no recognized prefix at all falls back to OpenRouter
  // with the whole string as the model id — e.g. already-deployed env
  // values and `npm run showcase:generate -- --model=...` overrides.
  it("routes an unprefixed legacy CHAT_MODEL to OpenRouter", () => {
    const config = makeConfig({ CHAT_MODEL: "google/gemini-3.7-flash" });
    const model = createModel(config) as unknown as { modelId?: string };
    expect(model.modelId).toBe("google/gemini-3.7-flash");
  });

  it("does not corrupt a legacy OpenRouter id carrying its own colon", () => {
    const config = makeConfig({ CHAT_MODEL: "openai/gpt-4o:extended" });
    const model = createModel(config) as unknown as { modelId?: string };
    expect(model.modelId).toBe("openai/gpt-4o:extended");
  });
});

describe("createModel DeepSeek reasoning options", () => {
  async function reasoningOptionsFor(
    chatModel: string,
    effort: string,
    modelOverride?: string,
  ) {
    const config = makeConfig({
      CHAT_MODEL: chatModel,
      CHAT_REASONING_EFFORT: effort as never,
      DEEPSEEK_API_KEY: "test-deepseek-key",
    });
    const model = createModel(config, modelOverride);
    lastDeepseekParams = undefined;
    await model.doGenerate({
      prompt: [],
    } as unknown as LanguageModelV3CallOptions);
    return (lastDeepseekParams?.providerOptions as Record<string, unknown> | undefined)
      ?.deepseek as { thinking?: { type?: string }; reasoningEffort?: string } | undefined;
  }

  // The single most important behavior in this whole file: @ai-sdk/deepseek
  // defaults `thinking` to "enabled" when no providerOptions are sent at
  // all, so the default CHAT_MODEL (deepseek:deepseek-flash) must ALWAYS get
  // an explicit `thinking` value — never empty options — or the agent starts
  // reasoning before every reply again (the exact regression commit 9719e79
  // fixed for the OpenRouter path).
  it("gives the default CHAT_MODEL an explicit disabled thinking option (CHAT_REASONING_EFFORT default 'none')", async () => {
    const options = await reasoningOptionsFor("deepseek:deepseek-flash", "none");
    expect(options).toEqual({ thinking: { type: "disabled" } });
  });

  it("keeps modelOverride calls on 'minimal'-equivalent behavior regardless of CHAT_REASONING_EFFORT", async () => {
    const options = await reasoningOptionsFor(
      "openrouter:google/gemini-2.5-flash",
      "xhigh",
      "deepseek:deepseek-flash",
    );
    expect(options).toEqual({ thinking: { type: "enabled" }, reasoningEffort: "low" });
  });

  it.each([
    ["none", { thinking: { type: "disabled" } }],
    ["minimal", { thinking: { type: "enabled" }, reasoningEffort: "low" }],
    ["low", { thinking: { type: "enabled" }, reasoningEffort: "low" }],
    ["medium", { thinking: { type: "enabled" }, reasoningEffort: "high" }],
    ["high", { thinking: { type: "enabled" }, reasoningEffort: "high" }],
    ["xhigh", { thinking: { type: "enabled" }, reasoningEffort: "max" }],
  ] as const)("maps CHAT_REASONING_EFFORT=%s to %o", async (effort, expected) => {
    const options = await reasoningOptionsFor("deepseek:deepseek-flash", effort);
    expect(options).toEqual(expected);
  });
});

// The real gate this repo lost when REASONING_MODEL_PREFIXES stopped being
// checked against the shipped CHAT_MODEL default (Fix 5, 2026-09 DeepSeek-
// direct review — provider.ts and .env.example both used to claim this test
// existed under test/provider-reasoning.test.ts; it didn't). Reads the
// REAL schema default (never a hardcoded second copy of it) and asserts
// whichever provider it resolves to actually gets reasoning suppressed:
//   - openrouter branch: the bare model id must be covered by
//     REASONING_MODEL_PREFIXES, or CHAT_REASONING_EFFORT silently does
//     nothing for it (supportsReasoningControl gates the OpenRouter branch
//     of createModel entirely).
//   - deepseek branch: no allowlist applies — createModel's DeepSeek branch
//     unconditionally sends an explicit `thinking` value (see
//     mapReasoningEffort) — verified here by actually calling
//     doGenerate and inspecting providerOptions.deepseek, not by re-stating
//     provider.ts's own source.
//
// A future default that moves to an uncovered OpenRouter family, or to a
// provider branch that stops sending explicit `thinking`, fails THIS test
// instead of silently reintroducing always-on reasoning.
// Branch chosen at MODULE scope, not inside a test body — `vitest/no-
// conditional-in-test` forbids an `if` inside `it()`, and picking the test
// via `it`/`it.skip` here is the standard way to run exactly one of two
// assertions depending on a value known before the test file even runs,
// without a conditional inside either test.
const shippedDefaultRef = parseModelRef(envSchema.shape.CHAT_MODEL.parse(undefined));
const itForOpenrouterDefault = shippedDefaultRef.provider === "openrouter" ? it : it.skip;
const itForDeepseekDefault = shippedDefaultRef.provider === "deepseek" ? it : it.skip;

describe("default CHAT_MODEL reasoning coverage gate", () => {
  itForOpenrouterDefault(
    "OpenRouter branch: the shipped default's bare id is covered by REASONING_MODEL_PREFIXES",
    () => {
      expect(supportsReasoningControl(shippedDefaultRef.modelId)).toBe(true);
    },
  );

  itForDeepseekDefault(
    "DeepSeek branch: the shipped default always gets an explicit `thinking` value",
    async () => {
      const shippedDefault = envSchema.shape.CHAT_MODEL.parse(undefined);
      const config = makeConfig({
        CHAT_MODEL: shippedDefault,
        CHAT_REASONING_EFFORT: "none",
        DEEPSEEK_API_KEY: "test-deepseek-key",
      });
      const model = createModel(config);
      lastDeepseekParams = undefined;
      await model.doGenerate({ prompt: [] } as unknown as LanguageModelV3CallOptions);
      const deepseekOptions = (
        lastDeepseekParams?.providerOptions as Record<string, unknown> | undefined
      )?.deepseek as { thinking?: { type?: string } } | undefined;
      expect(deepseekOptions?.thinking).toBeDefined();
    },
  );

  // Belt-and-suspenders: whichever branch above got skipped, this makes sure
  // the skip was a deliberate "not applicable", not silently vacuous —
  // exactly one of the two above must have actually run.
  it("resolves the shipped default to exactly one known provider", () => {
    expect(["openrouter", "deepseek"]).toContain(shippedDefaultRef.provider);
  });
});
