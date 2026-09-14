import {
  DEFAULT_MEMORY_REVIEW_INTERVAL,
  DEFAULT_SCENARIO_CONFIRM_THRESHOLD,
  DEFAULT_SKILL_REVIEW_INTERVAL,
  envSchema,
  type Config,
} from "../src/config.js";

// Test config built directly as an object — no env vars, no real API keys.
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    HOST: "127.0.0.1",
    OPENROUTER_API_KEY: "test-api-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    // The REAL shipped default, not a bare legacy OpenRouter id — Fix 7
    // (2026-09 DeepSeek-direct review): the whole suite used to run against
    // a bare `deepseek/deepseek-v4.1-flash` id (the OpenRouter branch),
    // which meant nothing exercised the DeepSeek-direct branch a real
    // deployment actually runs on and let two real defects (tool-result
    // images serialized as base64 text, generateObject losing json_schema)
    // ship unnoticed. Tests that specifically need the OpenRouter branch —
    // most of this suite's pre-existing mocked provider/route tests — pass
    // `CHAT_MODEL: "deepseek/deepseek-v4.1-flash"` (or another OpenRouter id)
    // explicitly via `overrides`.
    CHAT_MODEL: envSchema.shape.CHAT_MODEL.parse(undefined),
    // Real shipped default, not a second hardcoded copy — keeps the rest of
    // the suite exercising the same value as prod. Tests that need a
    // different effort override it point by point via `overrides`.
    CHAT_REASONING_EFFORT: envSchema.shape.CHAT_REASONING_EFFORT.parse(undefined),
    // Undefined = "operator never set it" (the real prod default — see Fix 4
    // in the 2026-09 review: an explicitly-set value must override built-in
    // DEFAULT_MODELS metadata, which requires distinguishing "unset" from
    // "explicitly true/false" all the way down to this Config object).
    // Tests that need an explicit override (either value) pass it via
    // `overrides`.
    CHAT_MODEL_SUPPORTS_VISION: undefined,
    OPENROUTER_IMAGE_MODEL: "google/gemini-3.1-flash-lite-image",
    CORS_ALLOWED_ORIGINS: undefined,
    ENABLE_AGENT_LOGGING: false,
    REFERO_API_KEY: undefined,
    GITHUB_TOKEN: undefined,
    GITHUB_ALLOW_PRIVATE_REPOS: false,
    S3_ENDPOINT: undefined,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_REGION: "ru-1",
    S3_PUBLIC_BASE_URL: undefined,
    S3_OBJECT_ACL: "public-read",
    S3_LEGACY_PUBLIC_BASE_URLS: undefined,
    IMAGE_GENERATION_TIMEOUT_MS: 90_000,
    STRUCTURED_MODEL: envSchema.shape.STRUCTURED_MODEL.parse(undefined),
    TRACE_DATABASE_URL: undefined,
    TRACE_RAW_TTL_DAYS: 14,
    ANALYSIS_MODEL: "openrouter:google/gemini-2.5-flash",
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
    VISION_MODEL: "openrouter:google/gemini-2.5-flash",
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
