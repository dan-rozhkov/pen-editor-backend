import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEMORY_REVIEW_INTERVAL,
  DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
  DEFAULT_SKILL_REVIEW_INTERVAL,
  loadConfig,
} from "../src/config.js";

// loadConfig reads process.env and calls process.exit(1) on a bad env.
// We swap process.env per test and make process.exit throw so we can assert
// on the failure path without killing the test runner.
const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

// Every test below sets the API key unless it's specifically exercising the
// missing-key failure path. OpenRouter is the only provider, so there is
// exactly one required key.
const BASE_ENV = { OPENROUTER_API_KEY: "key-123" };

describe("loadConfig", () => {
  it("parses a minimal valid env and applies defaults", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    const config = loadConfig();

    expect(config.OPENROUTER_API_KEY).toBe("key-123");
    expect(config.PORT).toBe(3001);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.CHAT_MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(config.S3_REGION).toBe("ru-1");
    expect(config.ENABLE_AGENT_LOGGING).toBe(false);
  });

  // The right threshold is a property of how a deployment is actually used,
  // so it must be tunable on production traffic without a code change.
  it("takes the review intervals from the env, defaulting to the shipped values", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    expect(loadConfig().MEMORY_REVIEW_INTERVAL).toBe(DEFAULT_MEMORY_REVIEW_INTERVAL);
    expect(loadConfig().SKILL_REVIEW_INTERVAL).toBe(DEFAULT_SKILL_REVIEW_INTERVAL);

    process.env = {
      ...BASE_ENV,
      MEMORY_REVIEW_INTERVAL: "2",
      SKILL_REVIEW_INTERVAL: "25",
    } as NodeJS.ProcessEnv;
    const config = loadConfig();
    expect(config.MEMORY_REVIEW_INTERVAL).toBe(2);
    expect(config.SKILL_REVIEW_INTERVAL).toBe(25);
  });

  // 0 would make `counter >= interval` true on every request and fire a full
  // background generateText per round-trip — refuse it at load time rather
  // than discover it as a bill.
  it("refuses an interval below 1", () => {
    process.env = {
      ...BASE_ENV,
      MEMORY_REVIEW_INTERVAL: "0",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig()).toThrow("process.exit(1)");
  });

  it("coerces PORT to a number and ENABLE_AGENT_LOGGING to a boolean", () => {
    process.env = {
      ...BASE_ENV,
      PORT: "8080",
      ENABLE_AGENT_LOGGING: "1",
    } as NodeJS.ProcessEnv;
    const config = loadConfig();

    expect(config.PORT).toBe(8080);
    expect(typeof config.PORT).toBe("number");
    expect(config.ENABLE_AGENT_LOGGING).toBe(true);
  });

  it("treats only true/1 as ENABLE_AGENT_LOGGING=true; false/0/other are false", () => {
    const cases: [string, boolean][] = [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["false", false],
      ["0", false],
      ["no", false],
      ["", false],
    ];
    for (const [value, expected] of cases) {
      process.env = {
        ...BASE_ENV,
        ENABLE_AGENT_LOGGING: value,
      } as NodeJS.ProcessEnv;
      expect(loadConfig().ENABLE_AGENT_LOGGING, `value=${JSON.stringify(value)}`).toBe(
        expected,
      );
    }
  });

  it("defaults ENABLE_AGENT_LOGGING to false when unset", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    expect(loadConfig().ENABLE_AGENT_LOGGING).toBe(false);
  });

  it("exits when OPENROUTER_API_KEY is missing", () => {
    process.env = {} as NodeJS.ProcessEnv;
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("exits when OPENROUTER_API_KEY is empty", () => {
    process.env = { OPENROUTER_API_KEY: "" } as NodeJS.ProcessEnv;
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
  });

  it("exits when S3_ENDPOINT is not a valid URL", () => {
    process.env = {
      ...BASE_ENV,
      S3_ENDPOINT: "not-a-url",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
  });

  it("accepts a valid S3_ENDPOINT URL", () => {
    process.env = {
      ...BASE_ENV,
      S3_ENDPOINT: "https://s3.example.test",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().S3_ENDPOINT).toBe("https://s3.example.test");
  });

  it("defaults trace/analysis vars and accepts overrides", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    const config = loadConfig();
    expect(config.TRACE_DATABASE_URL).toBeUndefined();
    expect(config.TRACE_RAW_TTL_DAYS).toBe(14);
    expect(config.ANALYSIS_MODEL).toBe("openrouter:google/gemini-2.5-flash");
    expect(config.EMBEDDINGS_MODEL).toBe("text-embedding-004");

    process.env = {
      ...BASE_ENV,
      TRACE_RAW_TTL_DAYS: "7",
      TRACE_DATABASE_URL: "postgres://u:p@h:5432/db?sslmode=no-verify",
    } as NodeJS.ProcessEnv;
    const overridden = loadConfig();
    expect(overridden.TRACE_RAW_TTL_DAYS).toBe(7);
    expect(overridden.TRACE_DATABASE_URL).toContain("postgres://");
  });

  it("defaults MEMORY_ENABLED to false and honors only true/1", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    expect(loadConfig().MEMORY_ENABLED).toBe(false);

    for (const [value, expected] of [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["false", false],
      ["0", false],
      ["", false],
    ] as [string, boolean][]) {
      process.env = {
        ...BASE_ENV,
        MEMORY_ENABLED: value,
      } as NodeJS.ProcessEnv;
      expect(loadConfig().MEMORY_ENABLED).toBe(expected);
    }
  });

  it("defaults SELF_SKILLS_ENABLED to false and honors only true/1", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    expect(loadConfig().SELF_SKILLS_ENABLED).toBe(false);

    for (const [value, expected] of [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["false", false],
      ["0", false],
      ["", false],
    ] as [string, boolean][]) {
      process.env = {
        ...BASE_ENV,
        SELF_SKILLS_ENABLED: value,
      } as NodeJS.ProcessEnv;
      expect(loadConfig().SELF_SKILLS_ENABLED).toBe(expected);
    }
  });

  // Opposite default from MEMORY_ENABLED/SELF_SKILLS_ENABLED on purpose: the
  // L2 layer is inert without traces and an analysis run, so it defaults on.
  it("defaults SCENARIOS_ENABLED to true and only 'false' turns it off", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    expect(loadConfig().SCENARIOS_ENABLED).toBe(true);

    for (const [value, expected] of [
      ["true", true],
      ["1", true],
      ["anything", true],
      ["false", false],
    ] as [string, boolean][]) {
      process.env = {
        ...BASE_ENV,
        SCENARIOS_ENABLED: value,
      } as NodeJS.ProcessEnv;
      expect(loadConfig().SCENARIOS_ENABLED, `value=${JSON.stringify(value)}`).toBe(
        expected,
      );
    }
  });

  // Deliberately different default from TRIAGE_MODE's "shadow": both share
  // the single TYPESAFE_API_KEY gate, but this one sits in the hot path of
  // every /api/chat request, while triage only runs from the offline
  // analysis CLI. Setting the key alone must not silently turn on a
  // user-facing network call — see src/config.ts's comment.
  it("defaults SKILL_ROUTING_MODE to off (opt-in, unlike TRIAGE_MODE)", () => {
    process.env = { ...BASE_ENV, TYPESAFE_API_KEY: "k" } as NodeJS.ProcessEnv;
    const config = loadConfig();
    expect(config.SKILL_ROUTING_MODE).toBe("off");
    expect(config.TRIAGE_MODE).toBe("shadow");
  });

  it("defaults the scenario confirmation threshold to 3 and accepts an override", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    expect(loadConfig().SCENARIO_CONFIRM_THRESHOLD).toBe(
      DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
    );

    process.env = {
      ...BASE_ENV,
      SCENARIO_CONFIRM_THRESHOLD: "5",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().SCENARIO_CONFIRM_THRESHOLD).toBe(5);
  });

  // A threshold of 1 would let a single session make a review due, which is
  // exactly what the per-turn review already covers — the whole point of
  // the L2 layer is repetition across MORE than one session.
  it("refuses a scenario confirmation threshold below 2", () => {
    process.env = {
      ...BASE_ENV,
      SCENARIO_CONFIRM_THRESHOLD: "1",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig()).toThrow("process.exit(1)");
  });
});

// TEMPORARY MIGRATION BRIDGE tests: OPENROUTER_REASONING_EFFORT /
// OPENROUTER_MODEL_SUPPORTS_VISION are the pre-rename names. loadConfig()
// must still honor them when the new name is absent, so an already-deployed
// Render environment doesn't fail validation the moment this ships.
//
// OPENROUTER_MODEL -> CHAT_MODEL is NOT bridged this way — see
// "loadConfig CHAT_MODEL legacy-name rejection" below and
// rejectStaleOpenrouterModel's comment in src/config.ts for why.
describe("loadConfig legacy env aliases", () => {
  it("falls back to OPENROUTER_REASONING_EFFORT when CHAT_REASONING_EFFORT is unset", () => {
    process.env = {
      ...BASE_ENV,
      OPENROUTER_REASONING_EFFORT: "high",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().CHAT_REASONING_EFFORT).toBe("high");
  });

  it("falls back to OPENROUTER_MODEL_SUPPORTS_VISION when CHAT_MODEL_SUPPORTS_VISION is unset", () => {
    process.env = {
      ...BASE_ENV,
      OPENROUTER_MODEL_SUPPORTS_VISION: "false",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().CHAT_MODEL_SUPPORTS_VISION).toBe(false);
  });
});

// OPENROUTER_MODEL aliases to CHAT_MODEL again. The alias was removed (and
// made a boot failure) while a DeepSeek-direct provider existed, because a
// bare legacy value silently meant "stay on OpenRouter" — i.e. the wrong
// PROVIDER with no error. With OpenRouter the only provider, the old name
// can mean exactly what it says.
describe("loadConfig OPENROUTER_MODEL legacy alias", () => {
  it("adopts OPENROUTER_MODEL when CHAT_MODEL is unset", () => {
    process.env = {
      ...BASE_ENV,
      OPENROUTER_MODEL: "vendor/legacy-model",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().CHAT_MODEL).toBe("vendor/legacy-model");
  });

  it("prefers an explicit CHAT_MODEL over a stale OPENROUTER_MODEL", () => {
    process.env = {
      ...BASE_ENV,
      CHAT_MODEL: "qwen/qwen3.8-flash",
      OPENROUTER_MODEL: "vendor/legacy-model",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().CHAT_MODEL).toBe("qwen/qwen3.8-flash");
  });

  it("falls back to the shipped default when neither name is set", () => {
    process.env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    expect(loadConfig().CHAT_MODEL).toBe("deepseek/deepseek-v4.1-flash");
  });
});

// A "deepseek:" reference selected a DeepSeek-direct provider that no longer
// exists. Read as a bare id it would be sent to OpenRouter as the literal
// model name "deepseek:deepseek-flash" and 404 every single turn — a runtime
// failure for a config mistake, so loadConfig refuses to start instead.
describe("loadConfig deepseek: model rejection", () => {
  it.each(["CHAT_MODEL", "STRUCTURED_MODEL", "ANALYSIS_MODEL", "VISION_MODEL"])(
    "exits loudly when %s carries a deepseek: prefix",
    (name) => {
      process.env = { ...BASE_ENV, [name]: "deepseek:deepseek-flash" } as NodeJS.ProcessEnv;
      expect(() => loadConfig()).toThrow("process.exit(1)");
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(name));
    },
  );

  it("accepts the OpenRouter spelling of a DeepSeek model", () => {
    process.env = {
      ...BASE_ENV,
      CHAT_MODEL: "deepseek/deepseek-v4.1-flash",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().CHAT_MODEL).toBe("deepseek/deepseek-v4.1-flash");
  });

  // The alias runs first, so a legacy OPENROUTER_MODEL carrying the dead
  // prefix is caught too rather than sailing in under the old name.
  it("catches a deepseek: prefix arriving through the OPENROUTER_MODEL alias", () => {
    process.env = {
      ...BASE_ENV,
      OPENROUTER_MODEL: "deepseek:deepseek-flash",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig()).toThrow("process.exit(1)");
  });
});
