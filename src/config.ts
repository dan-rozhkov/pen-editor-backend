import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().default("openai/gpt-4o"),
  // Comma-separated list of additional models clients may request via the
  // "model" field. OPENROUTER_MODEL is always allowed.
  OPENROUTER_ALLOWED_MODELS: z.string().optional(),
  // Comma-separated list of origins allowed by CORS. Empty = allow any origin
  // (suitable for local development only).
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  ENABLE_AGENT_LOGGING: z.coerce.boolean().default(false),
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

export function getAllowedModels(config: Config): string[] {
  return [
    ...new Set([
      config.OPENROUTER_MODEL,
      ...parseEnvList(config.OPENROUTER_ALLOWED_MODELS),
    ]),
  ];
}
