import type { Config } from "../src/config.js";

// Test config built directly as an object — no env vars, no real API keys.
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    HOST: "127.0.0.1",
    OPENROUTER_API_KEY: "test-api-key",
    OPENROUTER_MODEL: "google/gemini-2.5-flash",
    OPENROUTER_IMAGE_MODEL: "google/gemini-3.1-flash-lite-image",
    OPENROUTER_ALLOWED_MODELS: undefined,
    CORS_ALLOWED_ORIGINS: undefined,
    ENABLE_AGENT_LOGGING: false,
    REFERO_API_KEY: undefined,
    S3_ENDPOINT: undefined,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_REGION: "ru-1",
    IMAGE_GENERATION_TIMEOUT_MS: 90_000,
    ...overrides,
  };
}
