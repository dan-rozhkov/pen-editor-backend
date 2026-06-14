import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().default("google/gemini-2.5-flash"),
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
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default("ru-1"),
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
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", supportsVision: true },
  { id: "minimax/minimax-m3", label: "Minimax M3", supportsVision: true },
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
