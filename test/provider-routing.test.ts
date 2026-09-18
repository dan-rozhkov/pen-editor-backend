import { describe, expect, it } from "vitest";
import {
  bareModelId,
  createModel,
  parseModelRef,
  supportsReasoningControl,
} from "../src/ai/provider.js";
import {
  isOpenCodeProvider,
  providerHandlesToolResultImages,
  type ModelProviderId,
} from "../src/ai/modelRef.js";
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

  // opencode-go/ must be checked BEFORE opencode/, or "opencode-go/glm-5.3"
  // parses as provider=opencode, modelId="go/glm-5.3" — silently wrong
  // provider AND a mangled model id.
  it("recognizes the opencode-go/ prefix without falling into opencode/", () => {
    expect(parseModelRef("opencode-go/glm-5.3-flash")).toEqual({
      provider: "opencode-go",
      modelId: "glm-5.3-flash",
    });
  });

  it("recognizes the opencode/ prefix", () => {
    expect(parseModelRef("opencode/glm-5.3-flash")).toEqual({
      provider: "opencode",
      modelId: "glm-5.3-flash",
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

  // The core semantic change: bareModelId now strips ONLY the legacy
  // "openrouter:" colon prefix. A slash-prefixed opencode id must survive
  // whole, because it re-enters parseModelRef on the way back in (GET
  // /api/models -> UI pick -> POST /api/chat body -> createModel) and a
  // stripped prefix would silently misroute the request to OpenRouter with a
  // nonexistent model name.
  it("preserves the opencode-go/ prefix", () => {
    expect(bareModelId("opencode-go/glm-5.3-flash")).toBe("opencode-go/glm-5.3-flash");
  });

  it("preserves the opencode/ prefix", () => {
    expect(bareModelId("opencode/glm-5.3-flash")).toBe("opencode/glm-5.3-flash");
  });

  // The round trip the whole design hinges on: whatever bareModelId hands
  // back to a client must, when sent straight back as the next request's
  // model id, parse to the SAME provider it started as.
  it("round-trips the provider through parseModelRef(bareModelId(x)) for every known form", () => {
    const refs = [
      "openrouter:deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash",
      "opencode-go/glm-5.3-flash",
      "opencode/glm-5.3-flash",
    ];
    for (const ref of refs) {
      expect(parseModelRef(bareModelId(ref)).provider).toBe(parseModelRef(ref).provider);
    }
  });
});

describe("providerHandlesToolResultImages", () => {
  it("is true only for openrouter", () => {
    const expected: Record<ModelProviderId, boolean> = {
      openrouter: true,
      opencode: false,
      "opencode-go": false,
    };
    for (const [provider, result] of Object.entries(expected) as [
      ModelProviderId,
      boolean,
    ][]) {
      expect(providerHandlesToolResultImages(provider)).toBe(result);
    }
  });
});

describe("isOpenCodeProvider", () => {
  it("is true for both opencode providers and false for openrouter", () => {
    expect(isOpenCodeProvider("opencode")).toBe(true);
    expect(isOpenCodeProvider("opencode-go")).toBe(true);
    expect(isOpenCodeProvider("openrouter")).toBe(false);
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
//
// Scoped to provider "openrouter" only: REASONING_MODEL_PREFIXES and
// CHAT_REASONING_EFFORT are an OpenRouter-shaped concept
// (`{reasoning: {effort}}`) that createModel's OpenCode branch never touches
// at all (see provider.ts) — reasoning coverage is simply inapplicable to an
// "opencode"/"opencode-go" DEFAULT_MODELS entry, and asserting
// supportsReasoningControl against a bare opencode model id (which has no
// provider prefix left after parseModelRef) would either false-fail or,
// worse, coincidentally pass/fail based on an unrelated OpenRouter family
// prefix matching an OpenCode model's bare id by accident.
describe("selectable models reasoning coverage gate", () => {
  const openRouterModelIds = DEFAULT_MODELS.filter(
    (model) => parseModelRef(model.id).provider === "openrouter",
  ).map((model) => model.id);

  it.each(openRouterModelIds)("%s is covered by REASONING_MODEL_PREFIXES", (modelId) => {
    expect(supportsReasoningControl(parseModelRef(modelId).modelId)).toBe(true);
  });

  it("covers the shipped CHAT_MODEL default", () => {
    const shippedDefault = envSchema.shape.CHAT_MODEL.parse(undefined);
    expect(supportsReasoningControl(parseModelRef(shippedDefault).modelId)).toBe(true);
  });
});
