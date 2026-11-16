import { z } from "zod";
import { envSchema, type Config } from "../config.js";

// Local mode (Sideform Light's bundled backend, docs/specs/2026-11-16-
// sideform-light-local-mode.md): the server has NO model of its own. The
// config is therefore built from an explicit, closed set of values, not from
// the inherited environment, so an OPENROUTER_API_KEY / TYPESAFE_API_KEY /
// DATABASE_URL / ... that happens to be set on the user's machine can never
// switch a server-side feature on.
//
// Only PORT is read from the environment (and the token / data dir, which are
// not part of Config: see src/local/index.ts). The server always binds
// 127.0.0.1: HOST is ignored on purpose.

// The one deviation from the hosted schema: the OpenRouter key does not exist.
// It is the empty string (never a placeholder that looks like a key), and
// createModel() additionally refuses every non-BYOK model while
// SIDEFORM_LOCAL is on.
const localEnvSchema = envSchema.extend({ OPENROUTER_API_KEY: z.literal("") });

export function loadLocalConfig(env: Record<string, string | undefined> = process.env): Config {
  return localEnvSchema.parse({
    SIDEFORM_LOCAL: "1",
    PORT: env.PORT || "0",
    HOST: "127.0.0.1",
    OPENROUTER_API_KEY: "",
    // A local Ollama / LM Studio is a valid provider.
    BYOK_ALLOW_PRIVATE_NETWORK: "true",
    // The browser mode hands web tasks to the browse subagent.
    BROWSE_MODE: "agent",
    // Server-model helpers: off. (Unset keys below stay unset on purpose:
    // TYPESAFE_API_KEY, TRACE_DATABASE_URL, BETTER_AUTH_SECRET, POSTHOG_API_KEY,
    // S3_*, TAVILY_API_KEY, GITHUB_TOKEN, FAL_KEY, QUIVER_API_KEY, STEEL_API_KEY,
    // MCP_AUTH_TOKEN, EMBEDDINGS_API_KEY, MOBBIN_*, CORS_ALLOWED_ORIGINS, APP_ORIGIN.)
    VISION_MODEL: "",
    QA_JUDGE_MODEL: "off",
    SKILL_ROUTING_MODE: "off",
    IMAGE_RELEVANCE_MODE: "off",
    MEMORY_ENABLED: "false",
    SELF_SKILLS_ENABLED: "false",
    SCENARIOS_ENABLED: "false",
    ENABLE_AGENT_LOGGING: "false",
  });
}
