import { z } from "zod";

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
  // --- Vision (auxiliary vision model, optional) ---
  // Empty/whitespace = vision is off (src/services/vision.ts's
  // isVisionConfigured). Used both for analyze_image and for describing
  // images/screenshots to a text-only main model.
  VISION_MODEL: z.string().default("google/gemini-2.5-flash"),
  VISION_MAX_TOKENS: z.coerce.number().default(1200),
  VISION_TIMEOUT_MS: z.coerce.number().default(120_000),
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
