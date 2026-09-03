import { z } from "zod";

/**
 * Completed user turns between background memory reviews.
 *
 * Was 10, which measured the loop in its scarcest unit: one design message
 * spans 8-12 `POST /api/chat` round-trips but exactly one completed turn, so
 * a full day of real traffic (96 requests across 18 sessions on 2026-08-13)
 * bought one or two reviews and the agent effectively never saved anything
 * it was not explicitly told to save. 4 keeps a review from riding every
 * single turn while putting one within reach of a normal session.
 */
export const DEFAULT_MEMORY_REVIEW_INTERVAL = 4;

/**
 * Accumulated tool-call steps between background skill reviews. Unchanged at
 * 15: this threshold demonstrably fires (skill reviews ran throughout the
 * 08-13 traffic) and still produced one skill total, so the skill half's
 * problem is yield, not frequency — lowering it would only buy more
 * "Nothing to save." runs. Revisit once the per-run audit rows show what
 * fraction of reviews actually decline.
 */
export const DEFAULT_SKILL_REVIEW_INTERVAL = 15;

/**
 * Distinct sessions an L2 scenario must be confirmed in before it can make a
 * background review due. 3 mirrors the "not an anecdote" bar `bucketAtoms`/
 * `extractScenarios` already apply at extraction time (min 2 sessions) with
 * one extra session of margin, since this threshold is what actually
 * triggers an LLM call rather than just naming a pattern.
 */
export const DEFAULT_SCENARIO_CONFIRM_THRESHOLD = 3;

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().default("deepseek/deepseek-v4-pro"),
  OPENROUTER_IMAGE_MODEL: z
    .string()
    .default("google/gemini-3.1-flash-lite-image"),
  // Comma-separated list of additional models clients may request via the
  // "model" field. OPENROUTER_MODEL is always allowed.
  OPENROUTER_ALLOWED_MODELS: z.string().optional(),
  // Comma-separated list of origins allowed by CORS. Empty = allow any origin
  // (suitable for local development only).
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Note: do NOT use z.coerce.boolean() here — it treats any non-empty string
  // (incl. "false"/"0") as true, so ENABLE_AGENT_LOGGING=false would not disable
  // logging. Only "true"/"1" (case-insensitive) enable it; absent/anything else
  // is false.
  ENABLE_AGENT_LOGGING: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.toLowerCase();
      return s === "true" || s === "1";
    }),
  REFERO_API_KEY: z.string().optional(),
  // Internet search (optional) — enables the web_search/fetch_url tools (Tavily).
  // Free tier: 1,000 credits/month (basic search = 1 credit).
  TAVILY_API_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default("ru-1"),
  // Where the public reads the objects we PUT. Path-style providers (timeweb)
  // serve them straight off the S3 endpoint, which is why this stayed implicit
  // for so long — `${S3_ENDPOINT}/${S3_BUCKET}` is still the default. Cloudflare
  // R2 splits the two: its S3 endpoint (`<account>.r2.cloudflarestorage.com`)
  // only ever answers signed API calls, and public reads go through an
  // `r2.dev` subdomain or a custom domain. Set this to that domain — the bucket
  // is NOT part of the path there, so the value is a full base URL, not a host.
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  // Per-object canned ACL. Timeweb needs `public-read` on every PUT; R2 has no
  // object ACLs at all (public access is a bucket-level setting) and the header
  // is meaningless there. Set it to an empty string to omit the header.
  S3_OBJECT_ACL: z.string().default("public-read"),
  // Comma-separated public bases we no longer write to but must still READ:
  // after a provider migration, every already-published screen's HTML still
  // points its <img> tags at the old host, and `/api/showcase/image` only
  // proxies URLs on an allowlisted prefix (the bucket has no CORS — FIR-62).
  // Without this the gallery's old screens lose their images the moment
  // S3_ENDPOINT moves. Read-only: nothing ever uploads here.
  S3_LEGACY_PUBLIC_BASE_URLS: z.string().optional(),
  // Image generation is slow; a hung OpenRouter image endpoint must not hold
  // the client connection/request context open forever (see withTimeout in
  // src/ai/mcp.ts for the analogous MCP-side guard).
  IMAGE_GENERATION_TIMEOUT_MS: z.coerce.number().default(90_000),
  // --- Trace analysis (all optional; chat server works without them) ---
  // Postgres for raw traces + analysis artifacts (Aiven: append ?sslmode=no-verify —
  // TLS-encrypted, skips CA verification of Aiven's project CA).
  TRACE_DATABASE_URL: z.string().optional(),
  TRACE_RAW_TTL_DAYS: z.coerce.number().default(14),
  ANALYSIS_MODEL: z.string().default("google/gemini-2.5-flash"),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().default("text-embedding-004"),
  // --- MCP server (optional) ---
  // Shared bearer secret gating /api/mcp (streamable HTTP) and /api/mcp/ws
  // (browser bridge). Unset = the whole /api/mcp* surface returns 503,
  // mirroring the S3/Refero optional-feature gating pattern above.
  MCP_AUTH_TOKEN: z
    .string()
    .min(16, "MCP_AUTH_TOKEN must be at least 16 characters")
    .optional(),
  // --- Self-improvement loop (phase 1: persistent per-user memory) ---
  // Kill switch for the memory snapshot + `memory` tool + background review.
  // Same "true"/"1"-only transform as ENABLE_AGENT_LOGGING: z.coerce.boolean()
  // would treat "false" as true. Default false until verified live.
  MEMORY_ENABLED: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.toLowerCase();
      return s === "true" || s === "1";
    }),
  // Kill switch for phase 2 (self-authored skills: agent_skills table +
  // skill_manage/skill_view tools + the skill half of the background
  // review). Default false until the loop is verified live. Same parsing
  // as ENABLE_AGENT_LOGGING: z.coerce.boolean() would treat "false" as true.
  SELF_SKILLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.toLowerCase();
      return s === "true" || s === "1";
    }),
  // How many COMPLETED user turns between memory reviews, and how many
  // accumulated tool-call steps between skill reviews. Env-overridable
  // because the right value is a property of how a deployment is actually
  // used, not of the code: a design turn spans many `POST /api/chat`
  // round-trips but only one user turn, so the memory counter ticks in the
  // scarcest unit the loop has. Tuning that on production traffic must not
  // require a code change and a deploy. `.min(1)` because 0 would make
  // `>= interval` true on every single request and fire a full background
  // generateText per round-trip.
  MEMORY_REVIEW_INTERVAL: z.coerce.number().int().min(1).default(DEFAULT_MEMORY_REVIEW_INTERVAL),
  SKILL_REVIEW_INTERVAL: z.coerce.number().int().min(1).default(DEFAULT_SKILL_REVIEW_INTERVAL),
  // Kill switch for the L2 scenario layer (agent_scenarios + the review's
  // third due-source). Unlike MEMORY_ENABLED/SELF_SKILLS_ENABLED this
  // defaults ON: the layer is inert without traces and an `npm run analyze`
  // run to populate it, so leaving it on costs nothing on a deployment that
  // never mines a scenario — fetchDueScenarios just returns []. Parsed the
  // other way round from the other two flags for that reason: only the
  // literal string "false" turns it off, everything else (including unset)
  // stays true.
  SCENARIOS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false")
    .pipe(z.boolean()),
  // Distinct sessions an L2 scenario needs before it can trigger a review.
  // `.min(2)` because 1 would defeat the whole point of an L2 layer — a
  // single session is exactly what the per-turn review already sees.
  SCENARIO_CONFIRM_THRESHOLD: z.coerce
    .number()
    .int()
    .min(2)
    .default(DEFAULT_SCENARIO_CONFIRM_THRESHOLD),
  // --- Vision (auxiliary vision model, optional) ---
  // Empty/whitespace = vision is off (src/services/vision.ts's
  // isVisionConfigured). Used both for analyze_image and for describing
  // images/screenshots to a text-only main model.
  VISION_MODEL: z.string().default("google/gemini-2.5-flash"),
  VISION_MAX_TOKENS: z.coerce.number().default(1200),
  VISION_TIMEOUT_MS: z.coerce.number().default(120_000),
  // --- Product analytics (PostHog, optional) ---
  // Empty/unset key = analytics fully off: createAnalyticsClient (src/analytics/
  // posthog.ts) returns a no-op, no posthog-node instance, no network calls.
  // This is the default in dev, tests and CI. The host default only matters
  // once a key is actually set — but when it does, it matters silently: the
  // wrong region's ingest endpoint answers 200 to an unknown key and drops
  // the event, so a US/EU mismatch looks exactly like a working setup with no
  // traffic. It defaults to the EU cloud because that is where this project's
  // PostHog instance lives; a US-cloud deployment must set POSTHOG_HOST.
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default("https://eu.i.posthog.com"),
  // --- fal.ai image ops (optional): background removal + vectorization ---
  // Unset = the whole feature is off — GET /api/models reports it via
  // imageOps so the frontend hides the buttons, and remove_background/
  // vectorize_image are dropped from the per-request tool set (chatTurn.ts).
  FAL_KEY: z.string().optional(),
  // Model ids live in env, not code, same reasoning as OPENROUTER_IMAGE_MODEL:
  // swapping the fal.ai model a deployment uses shouldn't need a code change.
  FAL_BG_MODEL: z.string().default("smoretalk-ai/rembg-enhance"),
  FAL_VECTORIZE_MODEL: z.string().default("fal-ai/recraft/vectorize"),
  // These operations are fast (5-15s) but must not hold a client connection
  // open forever if fal.ai hangs — same reasoning as IMAGE_GENERATION_TIMEOUT_MS.
  FAL_TIMEOUT_MS: z.coerce.number().default(60_000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.format());
    process.exit(1);
  }
  return result.data;
}

export function parseEnvList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

// Single place for the CORS allowlist rule shared by the cors plugin and the
// manual headers on hijacked replies: empty allowlist = allow any origin
// (local development only).
export function isOriginAllowed(
  allowedOrigins: string[],
  origin: string,
): boolean {
  return allowedOrigins.length === 0 || allowedOrigins.includes(origin);
}

export interface ModelOption {
  id: string;
  label: string;
  supportsVision: boolean;
}

// The canonical chat model list with UI metadata. This is the single source of
// truth: it powers both the GET /api/models endpoint (consumed by the frontend
// dropdown) and the allowlist check in the chat route. The frontend keeps a
// hardcoded mirror only as an offline/first-paint fallback.
export const DEFAULT_MODELS: ModelOption[] = [
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    supportsVision: true,
  },
  { id: "z-ai/glm-5.2", label: "GLM 5.2", supportsVision: false },
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5", supportsVision: true },
  { id: "minimax/minimax-m3", label: "Minimax M3", supportsVision: true },
  {
    id: "xiaomi/mimo-v2.5-pro",
    label: "MiMo V2.5 Pro",
    supportsVision: false,
  },
  { id: "xiaomi/mimo-v2.5", label: "MiMo V2.5", supportsVision: true },
  // DeepSeek V4 (text-only — image parts are stripped before sending).
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    supportsVision: false,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    supportsVision: false,
  },
  { id: "tencent/hy3", label: "Hy3", supportsVision: false },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    label: "Nemotron 3 Ultra",
    supportsVision: false,
  },
  {
    id: "stepfun/step-3.7-flash",
    label: "Step 3.7 Flash",
    supportsVision: true,
  },
  {
    id: "x-ai/grok-build-0.1",
    label: "Grok Build 0.1",
    supportsVision: true,
  },
  {
    id: "thinkingmachines/inkling",
    label: "Inkling",
    supportsVision: true,
  },
  {
    id: "kwaipilot/kat-coder-pro-v2.5",
    label: "KAT-Coder-Pro V2.5",
    supportsVision: false,
  },
  {
    id: "x-ai/grok-4.20",
    label: "Grok 4.20",
    supportsVision: false,
  },
  {
    id: "google/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    supportsVision: true,
  },
  {
    id: "google/gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    supportsVision: true,
  },
  {
    id: "meta/muse-spark-1.3-contributor",
    label: "Muse Spark 1.3",
    supportsVision: true,
  },
];

// Full model list for a config: the built-in models, plus any extra models an
// operator allows via OPENROUTER_ALLOWED_MODELS, plus the active OPENROUTER_MODEL.
// Models without built-in metadata are assumed vision-capable and labelled by id.
export function getModels(config: Config): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const model of DEFAULT_MODELS) byId.set(model.id, model);
  const extras = [
    ...parseEnvList(config.OPENROUTER_ALLOWED_MODELS),
    config.OPENROUTER_MODEL,
  ];
  for (const id of extras) {
    if (!byId.has(id)) byId.set(id, { id, label: id, supportsVision: true });
  }
  return [...byId.values()];
}

export function getAllowedModels(config: Config): string[] {
  return getModels(config).map((model) => model.id);
}

// The model selected by default when a client sends no override.
export function getDefaultModel(config: Config): string {
  return config.OPENROUTER_MODEL;
}
