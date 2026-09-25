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
    // The REAL shipped default, never a second hardcoded copy of it, so the
    // suite exercises the same value prod runs on.
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
    MOBBIN_REDIRECT_ORIGINS: undefined,
    ENABLE_AGENT_LOGGING: false,
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
    BROWSE_CASCADE_MODEL: envSchema.shape.BROWSE_CASCADE_MODEL.parse(undefined),
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
    TYPESAFE_API_KEY: undefined,
    TYPESAFE_MODEL: "jev-latest",
    TYPESAFE_BASE_URL: "https://api.typesafe.ai/v1",
    SKILL_ROUTING_MODE: "off",
    SKILL_ROUTING_MIN_CONFIDENCE: 0.7,
    SKILL_ROUTING_GATE_THRESHOLD: 0.3,
    SKILL_ROUTING_FITS_THRESHOLD: 0.3,
    SKILL_ROUTING_ENFORCE_BUDGET_MS: 2_500,
    // Real shipped default ("off"), not a second hardcoded copy — a test
    // that needs Jev image relevance on overrides this point by point.
    IMAGE_RELEVANCE_MODE: envSchema.shape.IMAGE_RELEVANCE_MODE.parse(undefined),
    IMAGE_RELEVANCE_MIN_NOUL: envSchema.shape.IMAGE_RELEVANCE_MIN_NOUL.parse(undefined),
    IMAGE_RELEVANCE_TIMEOUT_MS: envSchema.shape.IMAGE_RELEVANCE_TIMEOUT_MS.parse(undefined),
    IMAGE_RELEVANCE_SHADOW_TIMEOUT_MS:
      envSchema.shape.IMAGE_RELEVANCE_SHADOW_TIMEOUT_MS.parse(undefined),
    QUIVER_API_KEY: undefined,
    QUIVER_MODEL: "arrow-2",
    QUIVER_BASE_URL: "https://api.quiver.ai/v1",
    QUIVER_TIMEOUT_MS: 180_000,
    TASTE_CHECK_MODE: envSchema.shape.TASTE_CHECK_MODE.parse(undefined),
    TASTE_CHECK_MIN_NOUL: envSchema.shape.TASTE_CHECK_MIN_NOUL.parse(undefined),
    TASTE_CHECK_TIMEOUT_MS: envSchema.shape.TASTE_CHECK_TIMEOUT_MS.parse(undefined),
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
