import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

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

describe("loadConfig", () => {
  it("parses a minimal valid env and applies defaults", () => {
    process.env = { OPENROUTER_API_KEY: "key-123" } as NodeJS.ProcessEnv;
    const config = loadConfig();

    expect(config.OPENROUTER_API_KEY).toBe("key-123");
    expect(config.PORT).toBe(3001);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.OPENROUTER_MODEL).toBe("google/gemini-2.5-flash");
    expect(config.S3_REGION).toBe("ru-1");
    expect(config.ENABLE_AGENT_LOGGING).toBe(false);
    expect(config.OPENROUTER_ALLOWED_MODELS).toBeUndefined();
  });

  it("coerces PORT to a number and ENABLE_AGENT_LOGGING to a boolean", () => {
    process.env = {
      OPENROUTER_API_KEY: "key",
      PORT: "8080",
      ENABLE_AGENT_LOGGING: "1",
    } as NodeJS.ProcessEnv;
    const config = loadConfig();

    expect(config.PORT).toBe(8080);
    expect(typeof config.PORT).toBe("number");
    expect(config.ENABLE_AGENT_LOGGING).toBe(true);
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
      OPENROUTER_API_KEY: "key",
      S3_ENDPOINT: "not-a-url",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
  });

  it("accepts a valid S3_ENDPOINT URL", () => {
    process.env = {
      OPENROUTER_API_KEY: "key",
      S3_ENDPOINT: "https://s3.example.test",
    } as NodeJS.ProcessEnv;
    expect(loadConfig().S3_ENDPOINT).toBe("https://s3.example.test");
  });
});
