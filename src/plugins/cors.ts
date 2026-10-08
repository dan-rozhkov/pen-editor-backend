import cors, { type FastifyCorsOptionsDelegate } from "@fastify/cors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAuthEnabled, isOriginAllowed, parseEnvList, type Config } from "../config.js";
import { resolveAuthSettings } from "../auth/settings.js";

// Cookies ride cross-origin ONLY for origins we name: the CORS allowlist and
// the frontend's APP_ORIGIN. Everything else — including every origin an
// empty allowlist reflects in local development — gets CORS without
// credentials, so no foreign page can ever send a request with a session
// cookie attached and read the answer.
export function isCredentialedOrigin(config: Config, origin: string | undefined): boolean {
  if (!origin) return false;
  const named = parseEnvList(config.CORS_ALLOWED_ORIGINS);
  if (config.APP_ORIGIN) named.push(config.APP_ORIGIN.replace(/\/+$/, ""));
  // Accounts on without APP_ORIGIN: the localhost dev frontend is the app.
  if (isAuthEnabled(config) && !config.APP_ORIGIN) named.push(resolveAuthSettings(config).appOrigin);
  return named.includes(origin);
}

// Manual CORS headers for hijacked replies (chat SSE, vector SSE), which
// bypass @fastify/cors.
export function credentialHeaders(config: Config, origin: string | undefined): Record<string, string> {
  return isCredentialedOrigin(config, origin) ? { "Access-Control-Allow-Credentials": "true" } : {};
}

// CORS for the hijacked MCP replies (/api/mcp, /mcp), which bypass
// @fastify/cors. Bearer-only endpoints: deliberately NO credentials header.
// WWW-Authenticate is exposed so browser MCP clients can read the 401 challenge.
export function setMcpCorsHeaders(config: Config, request: FastifyRequest, reply: FastifyReply): void {
  const origin = request.headers.origin;
  reply.raw.setHeader("Vary", "Origin");
  if (origin && isOriginAllowed(parseEnvList(config.CORS_ALLOWED_ORIGINS), origin)) {
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
  }
  reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  reply.raw.setHeader("Access-Control-Expose-Headers", MCP_EXPOSED_HEADERS.join(", "));
}

const MCP_EXPOSED_HEADERS = ["Mcp-Session-Id", "WWW-Authenticate"];
// Design-system library API (/api/ds): ETag/If-None-Match for immutable
// versions, Idempotency-Key on publish. A browser only reads a response header
// that is named here; Retry-After is set by the rate limiter on 429.
const DS_EXPOSED_HEADERS = ["ETag", "Location", "Idempotent-Replayed", "Retry-After"];

export async function registerCors(app: FastifyInstance, config: Config) {
  const allowedOrigins = parseEnvList(config.CORS_ALLOWED_ORIGINS);

  // Options delegate (not a static `origin`) because `credentials` must be
  // decided per request: see isCredentialedOrigin.
  const delegate: FastifyCorsOptionsDelegate = (request, callback) => {
    const origin = request.headers.origin;
    const credentialed = isCredentialedOrigin(config, origin);
    callback(null, {
      // Empty allowlist = reflect any origin (local development only). The
      // APP_ORIGIN is always allowed, even when the allowlist omits it.
      origin: credentialed || (allowedOrigins.length === 0 ? true : origin !== undefined && isOriginAllowed(allowedOrigins, origin)),
      credentials: credentialed,
      // DELETE and the extra headers are for /api/mcp (src/mcp/routes.ts):
      // @fastify/cors answers every OPTIONS preflight itself via a global
      // onRequest hook (strictPreflight) before any route handler — including
      // mcpRoutes' own OPTIONS handler — ever runs, so this plugin-level
      // config is what a real cross-origin MCP client (e.g. the MCP
      // Inspector) actually sees on preflight.
      // PATCH (library edit) and PUT (usage upsert) are for /api/ds.
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      // Both extra headers carry a credential the BROWSER owns and the server
      // never stores, so each must be named explicitly — this is an allowlist,
      // not a wildcard, and a missing entry kills the cross-origin preflight
      // before the request ever reaches a route handler. The deployed frontend
      // and backend are separate origins, so that is the normal path, not an
      // edge case.
      //   X-OpenCode-Key  — OpenCode BYOK key, sent to POST /api/chat when the
      //     picked model is an OpenCode one (docs/specs/2026-09-18-opencode-byok-design.md).
      //   X-Mobbin-Token  — the user's own Mobbin OAuth access token
      //     (docs/superpowers/specs/2026-09-18-mobbin-mcp-design.md).
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Mcp-Session-Id",
        "X-OpenCode-Key",
        "X-Mobbin-Token",
        "Idempotency-Key",
        "If-None-Match",
      ],
      exposedHeaders: [...MCP_EXPOSED_HEADERS, ...DS_EXPOSED_HEADERS],
    });
  };
  await app.register(cors, () => delegate);
}
