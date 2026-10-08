import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { extractBearerToken } from "../mcp/auth.js";
import { toWebRequest } from "./webBridge.js";
import { API_KEY_PREFIX, MCP_SCOPE, protectMcpRoute, type Auth } from "./index.js";

// One credential check for every route that accepts a machine caller: /mcp
// and /api/ds. Either an `sf_` API key or an OAuth access token (bearer JWT
// for the MCP resource, scope `mcp:tools`). Behaviour is what /mcp had before
// the extraction: an invalid API key falls through to the OAuth check, whose
// 401 carries the RFC 9728 `WWW-Authenticate` challenge, so there is one
// source for that header whatever the credential was.
export type BearerResult =
  | { ok: true; kind: "api_key"; userId: string; keyId: string }
  | { ok: true; kind: "oauth"; userId: string; clientId?: string; exp?: number; scopes: string[] }
  | { ok: false; reason: "rate_limited" }
  /** The OAuth guard's own 401 / 403 response, to be relayed. */
  | { ok: false; reason: "rejected"; response: Response };

export type BearerVerifier = (request: FastifyRequest) => Promise<BearerResult>;

function isRateLimited(error: unknown): boolean {
  return (error as { code?: string } | null | undefined)?.code === "RATE_LIMITED";
}

export function createBearerVerifier(auth: Auth, config: Config): BearerVerifier {
  // The guard's handler hands the subject back in the Response body, not via
  // shared state: concurrent requests interleave across the awaits.
  const guard = protectMcpRoute(auth, config, (_request, claims) =>
    typeof claims.sub === "string" && claims.sub
      ? new Response(
          JSON.stringify({
            sub: claims.sub,
            exp: claims.exp,
            clientId: typeof claims.azp === "string" ? claims.azp : claims.client_id,
          }),
          { status: 200 },
        )
      : new Response(null, { status: 401 }),
  );

  return async (request) => {
    const token = extractBearerToken(request.headers.authorization);
    if (token?.startsWith(API_KEY_PREFIX)) {
      try {
        const verified = await auth.api.verifyApiKey({ body: { key: token } });
        if (verified.valid && verified.key) return { ok: true, kind: "api_key", userId: verified.key.referenceId, keyId: verified.key.id };
        if (isRateLimited(verified.error)) return { ok: false, reason: "rate_limited" };
      } catch (err) {
        if (isRateLimited((err as { body?: unknown }).body)) return { ok: false, reason: "rate_limited" };
        request.log.warn({ err }, "[auth] API key verification failed");
      }
    }
    const response = await guard(toWebRequest(request));
    if (response.status === 200) {
      const claims = JSON.parse(await response.text()) as { sub: string; exp?: number; clientId?: string };
      return { ok: true, kind: "oauth", userId: claims.sub, clientId: claims.clientId, exp: claims.exp, scopes: [MCP_SCOPE] };
    }
    return { ok: false, reason: "rejected", response };
  };
}
