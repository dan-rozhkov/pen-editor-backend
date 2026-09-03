import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
  getAllowedModels,
  getDefaultModel,
  isOriginAllowed,
  parseEnvList,
} from "../src/config.js";
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

describe("getAllowedModels", () => {
  it("uses the curated design-agent model list", () => {
    expect(DEFAULT_MODELS.map((model) => model.id)).toEqual([
      "google/gemini-2.5-flash",
      "z-ai/glm-5.2",
      "moonshotai/kimi-k2.5",
      "minimax/minimax-m3",
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "tencent/hy3",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "stepfun/step-3.7-flash",
      "x-ai/grok-build-0.1",
      "thinkingmachines/inkling",
      "kwaipilot/kat-coder-pro-v2.5",
      "x-ai/grok-4.20",
      "google/gemini-3.5-flash-lite",
      "google/gemini-3.7-flash",
      "google/gemini-3.8-flash",
      "meta/muse-spark-1.3-contributor",
    ]);
  });

  it("includes the built-in default models", () => {
    const allowed = getAllowedModels(makeConfig());
    for (const model of DEFAULT_MODELS) {
      expect(allowed).toContain(model.id);
    }
  });

  it("includes extra models from OPENROUTER_ALLOWED_MODELS", () => {
    const allowed = getAllowedModels(
      makeConfig({ OPENROUTER_ALLOWED_MODELS: "custom/model-a, custom/model-b" }),
    );
    expect(allowed).toContain("custom/model-a");
    expect(allowed).toContain("custom/model-b");
  });

  it("always includes the active OPENROUTER_MODEL", () => {
    const allowed = getAllowedModels(
      makeConfig({ OPENROUTER_MODEL: "vendor/special-model" }),
    );
    expect(allowed).toContain("vendor/special-model");
  });

  it("does not duplicate models that are already built in", () => {
    const config = makeConfig({
      OPENROUTER_MODEL: DEFAULT_MODELS[0].id,
      OPENROUTER_ALLOWED_MODELS: DEFAULT_MODELS[0].id,
    });
    const allowed = getAllowedModels(config);
    expect(allowed.filter((id) => id === DEFAULT_MODELS[0].id)).toHaveLength(1);
  });
});

describe("getDefaultModel", () => {
  it("returns OPENROUTER_MODEL", () => {
    expect(getDefaultModel(makeConfig({ OPENROUTER_MODEL: "x/y" }))).toBe("x/y");
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
