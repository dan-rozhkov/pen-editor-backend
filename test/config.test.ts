import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
  getDefaultModel,
  isOriginAllowed,
  parseEnvList,
} from "../src/config.js";
import { bareModelId, parseModelRef } from "../src/ai/modelRef.js";
import { OPENCODE_CHAT_COMPLETIONS_MODELS } from "../src/ai/opencode.js";
import { makeConfig } from "./helpers.js";

describe("parseEnvList", () => {
  it("returns [] for undefined", () => {
    expect(parseEnvList(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(parseEnvList("")).toEqual([]);
  });

  it("splits a comma-separated list", () => {
    expect(parseEnvList("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(parseEnvList(" a , ,b,, c ")).toEqual(["a", "b", "c"]);
  });
});

describe("isOriginAllowed", () => {
  it("allows any origin when the allowlist is empty (dev mode)", () => {
    expect(isOriginAllowed([], "http://anything.example")).toBe(true);
  });

  it("allows origins present in the allowlist", () => {
    expect(
      isOriginAllowed(["https://app.example.com"], "https://app.example.com"),
    ).toBe(true);
  });

  it("rejects origins not in a non-empty allowlist", () => {
    expect(
      isOriginAllowed(["https://app.example.com"], "https://evil.example.com"),
    ).toBe(false);
  });
});

describe("DEFAULT_MODELS", () => {
  // The models a user can pick in the composer. Pinned because this list is
  // a cross-repo contract in both directions: pen-editor's
  // src/lib/__tests__/modelContract.test.ts reads it out of this checkout,
  // and POST /api/chat's allowlist is derived from it. Every id is BARE —
  // no "openrouter:" prefix — since this is exactly what GET /api/models
  // hands to the client (see the central invariant in src/ai/modelRef.ts).
  it("holds the selectable design-agent models", () => {
    expect(DEFAULT_MODELS).toEqual([
      {
        id: "meta/muse-spark-1.3-contributor",
        label: "Muse Spark 1.3",
        supportsVision: true,
      },
      { id: "qwen/qwen3.8-flash", label: "Qwen3.8 Flash", supportsVision: true },
      { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", supportsVision: true },
      {
        id: "deepseek/deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash",
        supportsVision: true,
      },
      { id: "stealth/union-alpha", label: "Union Alpha", supportsVision: true },
      {
        id: "google/gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        supportsVision: true,
      },
      {
        id: "tencent/hy4-preview",
        label: "Hy4 Preview",
        supportsVision: false,
      },
      { id: "z-ai/glm-5.3", label: "GLM 5.3", supportsVision: false },
      {
        id: "openai/gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        supportsVision: true,
      },
      { id: "z-ai/glm-5.2", label: "GLM 5.2", supportsVision: false },
      {
        id: "opencode-go/deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash · Go",
        supportsVision: true,
        requiresUserKey: true,
      },
      {
        id: "opencode-go/deepseek-v4-flash-vision-exp",
        label: "DeepSeek V4 Flash Vision · Go",
        supportsVision: true,
        requiresUserKey: true,
      },
      {
        id: "opencode-go/glm-5.3-flash",
        label: "GLM 5.3 Flash · Go",
        supportsVision: true,
        requiresUserKey: true,
      },
      {
        id: "opencode-go/glm-5.3",
        label: "GLM 5.3 · Go",
        supportsVision: false,
        requiresUserKey: true,
      },
      {
        id: "opencode-go/glm-5.2",
        label: "GLM 5.2 · Go",
        supportsVision: false,
        requiresUserKey: true,
      },
      {
        id: "opencode/deepseek-v4-flash",
        label: "DeepSeek V4 Flash · Zen",
        supportsVision: false,
        requiresUserKey: true,
      },
      {
        id: "opencode/glm-5.3-flash",
        label: "GLM 5.3 Flash · Zen",
        supportsVision: true,
        requiresUserKey: true,
      },
      {
        id: "opencode/kimi-k2.7-code",
        label: "Kimi K2.7 Code · Zen",
        supportsVision: true,
        requiresUserKey: true,
      },
    ]);
  });

  const openCodeModels = DEFAULT_MODELS.filter((model) =>
    ["opencode", "opencode-go"].includes(parseModelRef(model.id).provider),
  );

  it("has at least the eight OpenCode BYOK entries this task added", () => {
    expect(openCodeModels.length).toBeGreaterThanOrEqual(8);
  });

  it("marks every OpenCode entry requiresUserKey: true", () => {
    for (const model of openCodeModels) {
      expect(model.requiresUserKey, model.id).toBe(true);
    }
  });

  it("labels every Go entry with the · Go suffix and every Zen entry with · Zen", () => {
    for (const model of openCodeModels) {
      const provider = parseModelRef(model.id).provider;
      const suffix = provider === "opencode-go" ? " · Go" : " · Zen";
      expect(model.label.endsWith(suffix), model.id).toBe(true);
    }
  });

  // bareModelId must return the OpenCode entry VERBATIM, prefix and all —
  // regression guard for task 1's "bare and provider-qualified are the same
  // string" invariant (src/ai/modelRef.ts).
  it("round-trips every OpenCode entry's id through bareModelId unchanged", () => {
    for (const model of openCodeModels) {
      expect(bareModelId(model.id)).toBe(model.id);
    }
  });

  // Every OpenCode DEFAULT_MODELS entry must be an id createOpenCodeModel can
  // actually serve — otherwise a model only reachable from the /responses or
  // /messages endpoint family could be picked in the composer and fail only
  // in production (src/ai/opencode.ts's allowlist guard would throw at
  // request time, not at any test or CI step).
  it("has every OpenCode entry present in the matching OPENCODE_CHAT_COMPLETIONS_MODELS allowlist", () => {
    for (const model of openCodeModels) {
      const { provider, modelId } = parseModelRef(model.id);
      const allowlist =
        OPENCODE_CHAT_COMPLETIONS_MODELS[provider as "opencode" | "opencode-go"];
      expect(allowlist, model.id).toContain(modelId);
    }
  });

  // Pins the LIVE MEASUREMENT recorded above DEFAULT_MODELS (2026-09-18,
  // real Go key, blue/yellow split image, repeated per model). Vision on this
  // route is an endpoint property, so neither list is derivable from the
  // model names or from their OpenRouter twins — if an entry moves between
  // these two arrays, it must be because someone re-measured it, not because
  // it looked like it should.
  it("pins which OpenCode entries were measured vision-capable", () => {
    const visionCapable = openCodeModels.filter((m) => m.supportsVision).map((m) => m.id);
    expect(visionCapable).toEqual([
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/deepseek-v4-flash-vision-exp",
      "opencode-go/glm-5.3-flash",
      "opencode/glm-5.3-flash",
      "opencode/kimi-k2.7-code",
    ]);
  });

  // These three answered an image with an EMPTY completion 3/3 — no error, no
  // refusal. A `true` here would read as a working model gone quiet; `false`
  // routes the image through VISION_MODEL's text description instead.
  it("pins which OpenCode entries answered images with silence", () => {
    const textOnly = openCodeModels.filter((m) => !m.supportsVision).map((m) => m.id);
    expect(textOnly).toEqual([
      "opencode-go/glm-5.3",
      "opencode-go/glm-5.2",
      "opencode/deepseek-v4-flash",
    ]);
  });
});

describe("getDefaultModel", () => {
  it("returns the bare CHAT_MODEL id", () => {
    expect(getDefaultModel(makeConfig({ CHAT_MODEL: "x/y" }))).toBe("x/y");
  });

  it("strips a provider prefix off CHAT_MODEL", () => {
    expect(
      getDefaultModel(makeConfig({ CHAT_MODEL: "openrouter:google/gemini-2.5-flash" })),
    ).toBe("google/gemini-2.5-flash");
  });
});

describe("OPENROUTER_IMAGE_MODEL config", () => {
  it("defaults to the cheap gemini image model", () => {
    const config = makeConfig();
    expect(config.OPENROUTER_IMAGE_MODEL).toBe(
      "google/gemini-3.1-flash-lite-image",
    );
  });
});

// Real env-string parsing (the "false" cutoff, min(2) rejection) is covered
// in load-config.test.ts alongside the other *_ENABLED flags; this just
// pins the shipped defaults makeConfig() hands out to every other test.
describe("scenario layer config", () => {
  it("defaults the scenario layer on with a threshold of 3", () => {
    const config = makeConfig();
    expect(config.SCENARIOS_ENABLED).toBe(true);
    expect(config.SCENARIO_CONFIRM_THRESHOLD).toBe(
      DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
    );
  });
});
