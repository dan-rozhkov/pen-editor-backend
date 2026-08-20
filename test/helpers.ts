import {
  DEFAULT_MEMORY_REVIEW_INTERVAL,
  DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
  DEFAULT_SKILL_REVIEW_INTERVAL,
  type Config,
} from "../src/config.js";

// Test config built directly as an object — no env vars, no real API keys.
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    HOST: "127.0.0.1",
    OPENROUTER_API_KEY: "test-api-key",
    OPENROUTER_MODEL: "deepseek/deepseek-v4-pro",
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
    S3_PUBLIC_BASE_URL: undefined,
    S3_OBJECT_ACL: "public-read",
    S3_LEGACY_PUBLIC_BASE_URLS: undefined,
    IMAGE_GENERATION_TIMEOUT_MS: 90_000,
    TRACE_DATABASE_URL: undefined,
    TRACE_RAW_TTL_DAYS: 14,
    ANALYSIS_MODEL: "google/gemini-2.5-flash",
    EMBEDDINGS_API_KEY: undefined,
    EMBEDDINGS_MODEL: "text-embedding-004",
    MCP_AUTH_TOKEN: undefined,
    MEMORY_ENABLED: false,
    SELF_SKILLS_ENABLED: false,
    SCENARIOS_ENABLED: true,
    // The real defaults, not hardcoded numbers: a test that pins a threshold
    // should fail when the shipped default moves, not quietly keep testing
    // the old one.
    MEMORY_REVIEW_INTERVAL: DEFAULT_MEMORY_REVIEW_INTERVAL,
    SKILL_REVIEW_INTERVAL: DEFAULT_SKILL_REVIEW_INTERVAL,
    SCENARIO_CONFIRM_THRESHOLD: DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
    VISION_MODEL: "google/gemini-2.5-flash",
    VISION_MAX_TOKENS: 1200,
    VISION_TIMEOUT_MS: 120_000,
    POSTHOG_API_KEY: undefined,
    POSTHOG_HOST: "https://eu.i.posthog.com",
    FAL_KEY: undefined,
    FAL_BG_MODEL: "smoretalk-ai/rembg-enhance",
    FAL_VECTORIZE_MODEL: "fal-ai/recraft/vectorize",
    FAL_TIMEOUT_MS: 60_000,
    ...overrides,
  };
}

// TypeScript assertion helper for narrowing discriminated-union results
// (e.g. zod's `safeParse`, or a function returning `{ ok: true, ... } |
// { ok: false, ... }`) without an `if` inside the test body itself —
// `vitest/no-conditional-in-test` flags a conditional statement in a test
// block even when it exists only for type narrowing after an `expect(...)`
// already asserted the branch. Call `assert(x.ok)` (or `assert(x.success)`)
// right after asserting the discriminant to narrow the type for the rest of
// the test.
export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
