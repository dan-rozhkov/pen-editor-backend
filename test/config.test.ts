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
  // The design agent runs on exactly one model; the picker is gone, so this
  // list is the model, not a menu. Pinned so a stray addition can't quietly
  // put a second model back in front of users.
  it("holds the single design-agent model", () => {
    expect(DEFAULT_MODELS).toEqual([
      {
        id: "deepseek/deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash",
        supportsVision: true,
      },
    ]);
  });
});

describe("getDefaultModel", () => {
  it("returns OPENROUTER_MODEL", () => {
    expect(getDefaultModel(makeConfig({ OPENROUTER_MODEL: "x/y" }))).toBe(
      "x/y",
    );
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
