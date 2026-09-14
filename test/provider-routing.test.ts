import { describe, expect, it } from "vitest";
import {
  bareModelId,
  createModel,
  parseModelRef,
  supportsReasoningControl,
} from "../src/ai/provider.js";
import { DEFAULT_MODELS, envSchema } from "../src/config.js";
import { makeConfig } from "./helpers.js";

// OpenRouter is the only provider. A DeepSeek-direct branch existed briefly
// and is gone (see src/ai/modelRef.ts) — what survives it is the prefix
// parsing, because deployed env values still carry "openrouter:" and because
// an OpenRouter id can contain a colon of its own. No network call happens
// building any of the model objects below.

describe("parseModelRef", () => {
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
  it("does not mistake a colon inside a bare OpenRouter id for a provider prefix", () => {
    expect(parseModelRef("openai/gpt-4o:extended")).toEqual({
      provider: "openrouter",
      modelId: "openai/gpt-4o:extended",
    });
    expect(parseModelRef("meta/llama:free")).toEqual({
      provider: "openrouter",
      modelId: "meta/llama:free",
    });
  });

  it("treats an unprefixed string as a bare OpenRouter id", () => {
    expect(parseModelRef("google/gemini-3.7-flash")).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.7-flash",
    });
  });
});

describe("bareModelId", () => {
  it("strips a recognized provider prefix", () => {
    expect(bareModelId("openrouter:google/gemini-2.5-flash")).toBe(
      "google/gemini-2.5-flash",
    );
  });

  it("returns a bare id unchanged", () => {
    expect(bareModelId("google/gemini-3.7-flash")).toBe("google/gemini-3.7-flash");
  });
});

describe("createModel provider routing", () => {
  it("routes an openrouter: prefixed CHAT_MODEL to OpenRouter, prefix stripped", () => {
    const config = makeConfig({ CHAT_MODEL: "openrouter:google/gemini-2.5-flash" });
    const model = createModel(config) as unknown as { modelId?: string };
    expect(model.modelId).toBe("google/gemini-2.5-flash");
  });

  it("routes an unprefixed CHAT_MODEL to OpenRouter", () => {
    const config = makeConfig({ CHAT_MODEL: "google/gemini-3.7-flash" });
    const model = createModel(config) as unknown as { modelId?: string };
    expect(model.modelId).toBe("google/gemini-3.7-flash");
  });

  it("does not corrupt an OpenRouter id carrying its own colon", () => {
    const config = makeConfig({ CHAT_MODEL: "openai/gpt-4o:extended" });
    const model = createModel(config) as unknown as { modelId?: string };
    expect(model.modelId).toBe("openai/gpt-4o:extended");
  });

  it("uses a per-request model over CHAT_MODEL", () => {
    const config = makeConfig({ CHAT_MODEL: "google/gemini-3.7-flash" });
    const model = createModel(config, "qwen/qwen3.8-flash", {
      chatAgent: true,
    }) as unknown as { modelId?: string };
    expect(model.modelId).toBe("qwen/qwen3.8-flash");
  });
});

// A model a user can PICK whose family is outside REASONING_MODEL_PREFIXES
// silently gets no reasoning cap at all — the exact way the agent once ended
// up thinking before every reply. The list of selectable models is the one
// thing that can drift here now that there are four of them, so gate every
// entry, plus the shipped default (which need not be in DEFAULT_MODELS).
describe("selectable models reasoning coverage gate", () => {
  it.each(DEFAULT_MODELS.map((model) => model.id))(
    "%s is covered by REASONING_MODEL_PREFIXES",
    (modelId) => {
      expect(supportsReasoningControl(modelId)).toBe(true);
    },
  );

  it("covers the shipped CHAT_MODEL default", () => {
    const shippedDefault = envSchema.shape.CHAT_MODEL.parse(undefined);
    expect(supportsReasoningControl(parseModelRef(shippedDefault).modelId)).toBe(true);
  });
});
