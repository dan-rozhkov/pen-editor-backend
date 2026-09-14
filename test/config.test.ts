import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
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
