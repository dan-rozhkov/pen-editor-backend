import { z } from "zod";
import { bareModelId } from "./ai/modelRef.js";

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

// Exported so tests can pull the real shipped default for a given var (e.g.
// CHAT_MODEL) without hardcoding it a second time — see
// test/provider-routing.test.ts and test/provider-reasoning.test.ts.
export const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  // Still required: VISION_MODEL/ANALYSIS_MODEL, image generation
  // (src/services/imageGen.ts) and the showcase default all route through
  // OpenRouter regardless of which provider CHAT_MODEL points at.
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  // DeepSeek-direct API key for the "deepseek:" branch of
  // src/ai/provider.ts's createModel — required unconditionally (not only
  // when CHAT_MODEL happens to point at DeepSeek) because CHAT_MODEL's own
  // default lives on that branch.
  DEEPSEEK_API_KEY: z.string().min(1, "DEEPSEEK_API_KEY is required"),
  // A bare id is a legacy OpenRouter id (see src/ai/provider.ts's
  // parseModelRef); "deepseek:"/"openrouter:" prefixes pick the provider
  // explicitly. Renamed from OPENROUTER_MODEL now that this identifies the
  // chat model in general, not an OpenRouter-specific setting — see the
  // loadConfig() legacy fallback below for the migration bridge.
  CHAT_MODEL: z.string().default("deepseek:deepseek-flash"),
  // How hard the model "thinks" before answering. On the OpenRouter branch
  // this only takes effect for the subset of models whose family is in
  // src/ai/provider.ts's REASONING_MODEL_PREFIXES; on the DeepSeek-direct
  // branch it always applies (see provider.ts's mapReasoningEffort).
  // Measured live against deepseek/deepseek-v4.1-flash over OpenRouter
  // (real OpenRouter calls, 2026-09): "minimal" and "high" produced
  // IDENTICAL results, both pinned at the reasoning-token budget ceiling
  // (1200/1200 and 1500/1500 tokens, ~4200 chars of reasoning either way) —
  // deepseek ignores `effort` gradations entirely over OpenRouter.
  // `reasoning.max_tokens: 200` was ALSO ignored (came back at 1501 tokens),
  // so it's not a usable lever either. The only value that actually
  // suppressed reasoning was "none" (reasoning_tokens: 0), and a
  // tool-calling turn still worked correctly under it (batch_design still
  // got called, args carried the HTML as expected). Hence the default here
  // is "none", not "minimal". An operator who points CHAT_MODEL at a family
  // where gradations DO work (e.g. anthropic/* over OpenRouter, unverified
  // here but plausible from OpenRouter's docs) can raise this back to
  // "minimal"/"low" without a code change.
  //
  // Scope: this only reaches the main chat model (src/ai/provider.ts's
  // createModel(config) with no modelOverride, i.e. the /api/chat route).
  // Helper-role calls that pass a modelOverride (ANALYSIS_MODEL, VISION_MODEL,
  // selfimprove review, user skills, prototype-link) keep the pre-existing
  // "minimal" effort regardless of this var — this was measured for the chat
  // agent, not for analysis-style tasks that want the model to actually think.
  CHAT_REASONING_EFFORT: z
    .enum(["xhigh", "high", "medium", "low", "minimal", "none"])
    .default("none"),
  // A CHAT_MODEL with no entry in DEFAULT_MODELS is assumed
  // vision-capable (getModels' convention below). Set this to "false" when an
  // operator points CHAT_MODEL at a text-only model: otherwise every
  // image part is handed straight to a model that cannot read it, which is
  // the one invariant src/ai/vision-messages.ts exists to hold. Only
  // "false"/"0" (case-insensitive) turn it off; absent = assume vision.
  //
  // Tri-state on purpose: `undefined` (the var was never set) is distinct
  // from an explicit `true`/`false`, because getModels() below needs to know
  // WHICH it got. Before this fix, the transform collapsed "unset" straight
  // to `true`, so an operator setting this for the DEFAULT (built-in)
  // CHAT_MODEL had no effect at all — getModels() only ever consulted this
  // value for an id that ISN'T already in DEFAULT_MODELS, and the default id
  // always is. Every other reader keeps seeing a plain boolean: getModels()
  // resolves the `undefined` case itself (falls back to the built-in
  // metadata, or `true` for a totally unlisted id) before this ever reaches
  // ModelOption.supportsVision.
  CHAT_MODEL_SUPPORTS_VISION: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const s = v.toLowerCase();
      return !(s === "false" || s === "0");
    }),
  OPENROUTER_IMAGE_MODEL: z
    .string()
    .default("google/gemini-3.1-flash-lite-image"),
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
  // GitHub REST access for read_design_repo/read_repo_files (src/services/
  // github.ts). Unset = unauthenticated requests only — public repos work,
  // capped at GitHub's ~60 req/hour/IP. Set a personal access token (no
  // special scopes needed for public repos; `repo` scope to also read
  // private repos the token owner can see) to raise that to 5000 req/hour.
  GITHUB_TOKEN: z.string().optional(),
  // SECURITY: by default this feature only ever reads PUBLIC repos, even
  // when GITHUB_TOKEN is set — every token-bearing request is preceded by
  // an unauthenticated visibility probe (ensurePublicRepoAccess in
  // src/services/github.ts). Without that gate, an unauthenticated route
  // backed by a token would let anyone on the internet read the token
  // owner's private repos through us. Set this to "true" ONLY for a
  // trusted, single-operator deployment that deliberately wants the agent
  // to read the token owner's own private repos. Same "true"/"1"-only
  // parsing as ENABLE_AGENT_LOGGING: z.coerce.boolean() would treat
  // "false" as true.
  GITHUB_ALLOW_PRIVATE_REPOS: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.toLowerCase();
      return s === "true" || s === "1";
    }),
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
  // Model used by generateObject() call sites that need a real json_schema
  // response format (src/routes/userSkills.ts, src/ai/prototype-link.ts).
  // Exists because @ai-sdk/deepseek's createDeepSeek (node_modules/@ai-sdk/
  // deepseek/dist/index.js) never sets `supportsStructuredOutputs`, so it
  // always reads as false (see the model's own doGenerate, which gates
  // response_format on `this.config.supportsStructuredOutputs === true`) —
  // response_format degrades to `{type:"json_object"}` and the schema is
  // pushed into a system message instead, which is far more likely to drift
  // out of shape and throw generateObject's NoObjectGeneratedError.
  // OpenRouter's provider DOES send a real `json_schema` response_format
  // (@openrouter/ai-sdk-provider dist/index.js:3573), which is exactly what
  // both call sites relied on before CHAT_MODEL moved to DeepSeek-direct —
  // so this pins them to the same OpenRouter model the chat agent used to
  // run on, via `createModel(config, config.STRUCTURED_MODEL)`, rather than
  // silently degrading two working features as a side effect of the chat
  // provider migration.
  STRUCTURED_MODEL: z.string().default("openrouter:deepseek/deepseek-v4.1-flash"),
  // --- Trace analysis (all optional; chat server works without them) ---
  // Postgres for raw traces + analysis artifacts (Aiven: append ?sslmode=no-verify —
  // TLS-encrypted, skips CA verification of Aiven's project CA).
  TRACE_DATABASE_URL: z.string().optional(),
  TRACE_RAW_TTL_DAYS: z.coerce.number().default(14),
  ANALYSIS_MODEL: z.string().default("openrouter:google/gemini-2.5-flash"),
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
  MEMORY_REVIEW_INTERVAL: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_MEMORY_REVIEW_INTERVAL),
  SKILL_REVIEW_INTERVAL: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SKILL_REVIEW_INTERVAL),
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
  VISION_MODEL: z.string().default("openrouter:google/gemini-2.5-flash"),
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

// TEMPORARY MIGRATION BRIDGE: OPENROUTER_REASONING_EFFORT /
// OPENROUTER_MODEL_SUPPORTS_VISION were renamed to CHAT_REASONING_EFFORT /
// CHAT_MODEL_SUPPORTS_VISION (these vars have long meant "the chat model",
// not something OpenRouter-specific). Without this, a deployment (Render)
// still carrying the old names would fail validation the moment this code
// ships, before anyone updates its env vars. For each pair, the old name is
// used ONLY when the new name is absent/empty and the old name is actually
// set. Remove this once every deployment's env has been updated to the new
// names.
//
// OPENROUTER_MODEL -> CHAT_MODEL is deliberately NOT in this list — see
// rejectStaleOpenrouterModel below for why silently bridging it would be
// actively harmful now that CHAT_MODEL can point at a different PROVIDER,
// not just a different model on the same one.
const LEGACY_ENV_ALIASES: Array<[newName: string, oldName: string]> = [
  ["CHAT_REASONING_EFFORT", "OPENROUTER_REASONING_EFFORT"],
  ["CHAT_MODEL_SUPPORTS_VISION", "OPENROUTER_MODEL_SUPPORTS_VISION"],
];

// OPENROUTER_MODEL -> CHAT_MODEL used to be bridged the same way as the two
// aliases above. That bridge is gone on purpose: every deployment already
// carrying OPENROUTER_MODEL (e.g. Render, set to
// "deepseek/deepseek-v4.1-flash") would otherwise have that value silently
// adopted as CHAT_MODEL, which parseModelRef (src/ai/provider.ts) reads as a
// legacy BARE OPENROUTER id — so the chat agent would keep running on
// OpenRouter, DEEPSEEK_API_KEY notwithstanding, with no error, no warning,
// and GET /api/models reporting two models where the API contract promises
// exactly one (DEFAULT_MODELS' single entry plus this stale extra). The
// "bridge for a seamless deploy" justification the other two aliases still
// have does not apply here: DEEPSEEK_API_KEY is REQUIRED unconditionally
// (see this schema's own DEEPSEEK_API_KEY comment), so an operator deploying
// this code is already forced to touch env vars — there is no seamless path
// to protect. A loud failure is strictly better than a quiet wrong provider.
function rejectStaleOpenrouterModel(env: Record<string, string | undefined>): void {
  if (env.OPENROUTER_MODEL && !env.CHAT_MODEL) {
    console.error(
      "OPENROUTER_MODEL is set but CHAT_MODEL is not. OPENROUTER_MODEL was " +
        "renamed to CHAT_MODEL and no longer aliases automatically — a bare " +
        "value now means \"legacy OpenRouter id\", so silently reusing it " +
        "would keep the chat agent on OpenRouter instead of moving it to " +
        "DeepSeek-direct. Set CHAT_MODEL=deepseek:deepseek-flash (or an " +
        "explicit \"openrouter:<id>\" to stay on OpenRouter) and remove " +
        "OPENROUTER_MODEL.",
    );
    process.exit(1);
  }
}

export function loadConfig(): Config {
  const env: Record<string, string | undefined> = { ...process.env };
  rejectStaleOpenrouterModel(env);
  for (const [newName, oldName] of LEGACY_ENV_ALIASES) {
    if (!env[newName] && env[oldName]) {
      env[newName] = env[oldName];
    }
  }
  const result = envSchema.safeParse(env);
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

// The chat model list with UI metadata. The design agent runs on exactly one
// model — there is no per-request model choice and no user-facing picker — so
// this holds a single entry whose id must match CHAT_MODEL's default above,
// stripped of its provider prefix (see the central invariant in
// src/ai/provider.ts: bareModelId — GET /api/models, raw_traces, and the
// showcase gallery's `model` column must only ever see the bare id, never
// "deepseek:"/"openrouter:"). It powers GET /api/models (the frontend reads
// `supportsVision` from it to decide whether images may be attached) and the
// vision metadata lookup in src/ai/vision-messages.ts. An operator who points
// CHAT_MODEL at a different id still works: getModels() appends it below.
export const DEFAULT_MODELS: ModelOption[] = [
  {
    id: "deepseek-flash",
    label: "DeepSeek Flash",
    supportsVision: true,
  },
];

// Full model list for a config: the built-in model, plus the active
// CHAT_MODEL (bare, provider prefix stripped) when an operator has pointed
// it somewhere else (and any model a showcase/CLI run overrides to, which is
// looked up here for its vision metadata). A model without built-in metadata
// is labelled by id and assumed vision-capable unless
// CHAT_MODEL_SUPPORTS_VISION says otherwise.
//
// CHAT_MODEL_SUPPORTS_VISION is applied whenever it is EXPLICITLY set
// (!== undefined) — including when CHAT_MODEL matches a built-in
// DEFAULT_MODELS entry, which it does for the shipped default. Before this
// fix the flag only ever reached a freshly-synthesized entry (the `else`
// branch below), so an operator setting CHAT_MODEL_SUPPORTS_VISION=false for
// the default model had zero effect: the built-in `supportsVision: true`
// always won. `undefined` (never set) still defers to the built-in metadata
// unchanged, or `true` for a totally unlisted id — same as before.
export function getModels(config: Config): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const model of DEFAULT_MODELS) byId.set(model.id, model);
  const chatModelId = bareModelId(config.CHAT_MODEL);
  const builtin = byId.get(chatModelId);
  if (builtin) {
    if (config.CHAT_MODEL_SUPPORTS_VISION !== undefined) {
      byId.set(chatModelId, {
        ...builtin,
        supportsVision: config.CHAT_MODEL_SUPPORTS_VISION,
      });
    }
  } else {
    byId.set(chatModelId, {
      id: chatModelId,
      label: chatModelId,
      supportsVision: config.CHAT_MODEL_SUPPORTS_VISION ?? true,
    });
  }
  return [...byId.values()];
}

// The model selected by default when a client sends no override. Bare
// (provider prefix stripped) — see the central invariant above.
export function getDefaultModel(config: Config): string {
  return bareModelId(config.CHAT_MODEL);
}
