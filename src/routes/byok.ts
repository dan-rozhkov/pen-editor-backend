import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { createByokFetch, parseByokBaseUrl } from "../ai/byokNetwork.js";
import { readCredentialHeader } from "../lib/credentialHeader.js";

// Server-side relay for "Load models": the browser cannot call an arbitrary
// provider's /models (CORS), and the SSRF guard must run on our side anyway.
// The key arrives in a header and is never stored or logged
// (docs/specs/2026-11-13-byok-custom-provider-design.md).

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_MODELS = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface ByokRouteOptions {
  /** Test seam; defaults to the SSRF-guarded fetch. */
  fetchImpl?: typeof fetch;
}

export interface ByokModelInfo {
  id: string;
  contextWindow?: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

// Defensive: `{data: [...]}` (OpenAI shape) or a bare array.
export function extractByokModels(payload: unknown): ByokModelInfo[] {
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const byId = new Map<string, ByokModelInfo>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0 || byId.has(rec.id)) continue;
    const contextWindow = positiveInt(rec.context_length) ?? positiveInt(rec.context_window);
    byId.set(rec.id, contextWindow ? { id: rec.id, contextWindow } : { id: rec.id });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, MAX_MODELS);
}

/** Reads at most MAX_BODY_BYTES, cancelling the stream past the cap. */
async function readCappedText(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Outcome =
  | { ok: true; models: ByokModelInfo[] }
  | { ok: false; reason: "invalid_key" | "no_model_list" | "upstream_error" };

async function loadModels(
  baseUrl: string,
  apiKey: string,
  doFetch: typeof fetch,
): Promise<Outcome> {
  try {
    const res = await doFetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const early = (reason: "invalid_key" | "no_model_list" | "upstream_error"): Outcome => {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, reason };
    };
    if (res.status === 401 || res.status === 403) return early("invalid_key");
    if (res.status === 404 || res.status === 405) return early("no_model_list");
    if (!res.ok) return early("upstream_error");
    const text = await readCappedText(res);
    if (text === undefined) return { ok: false, reason: "upstream_error" };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, reason: "upstream_error" };
    }
    return { ok: true, models: extractByokModels(payload) };
  } catch {
    // Network error, timeout, or the SSRF guard refusing a private address.
    // Deliberately no detail: the error text could echo the key's URL.
    return { ok: false, reason: "upstream_error" };
  }
}

export async function byokRoutes(app: FastifyInstance, config: Config, options: ByokRouteOptions = {}) {
  const allowPrivateNetwork = config.BYOK_ALLOW_PRIVATE_NETWORK;
  const doFetch = options.fetchImpl ?? createByokFetch({ allowPrivateNetwork });

  app.post(
    "/api/byok/models",
    {
      // Unauthenticated outbound relay: same conservative budget as
      // /api/opencode/validate.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const rawBaseUrl = readCredentialHeader(request.headers["x-byok-base-url"]);
      const apiKey = readCredentialHeader(request.headers["x-byok-key"]);
      if (!rawBaseUrl || !apiKey) {
        return reply.status(400).send({
          error: "Loading models requires your base URL and API key (X-BYOK-Base-URL and X-BYOK-Key headers).",
          code: "byok_key_required",
        });
      }
      const parsed = parseByokBaseUrl(rawBaseUrl, { allowPrivateNetwork });
      if (!parsed.ok) {
        return reply.status(400).send({
          error: "The base URL is not allowed. Use a public https:// URL without credentials, query or fragment.",
          code: "byok_base_url_invalid",
        });
      }
      const outcome = await loadModels(parsed.url, apiKey, doFetch);
      return reply.send(outcome);
    },
  );
}
