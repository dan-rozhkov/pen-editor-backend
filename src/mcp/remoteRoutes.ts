import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { ClaimPool } from "../auth/claim.js";
import { API_KEY_PREFIX, protectMcpRoute, type Auth } from "../auth/index.js";
import { resolveAuthSettings } from "../auth/settings.js";
import { sendWebResponse, toWebRequest } from "../auth/webBridge.js";
import { setMcpCorsHeaders } from "../plugins/cors.js";
import { extractBearerToken } from "./auth.js";
import { serveStreamable } from "./streamable.js";
import { resolveCanvasWidgetSettings } from "./canvasWidget.js";
import { TICKET_SESSION_MAX_MS } from "./bridgeTickets.js";
import type { SessionCredential } from "./bridge.js";

// The account-scoped remote MCP endpoint (`/mcp`). Same tool surface as the
// legacy `/api/mcp`, but the caller is an account: an OAuth access token or an
// `sf_` API key, never the shared static token. The resolved user id is the
// bridge owner, so bridged calls only reach that user's own editor tabs.
export async function remoteMcpRoutes(app: FastifyInstance, config: Config, pool: ClaimPool | null = null): Promise<void> {
  const auth: Auth | null = app.auth;
  const { appOrigin, baseUrl } = resolveAuthSettings(config);
  const widget = resolveCanvasWidgetSettings(config, appOrigin, baseUrl);

  // One-row existence check against the auth tables; no pool (tests without a
  // DB) means nothing to re-check. Table names are from migration 016.
  async function rowExists(sql: string, params: unknown[]): Promise<boolean> {
    if (!pool) return true;
    const client = await pool.connect();
    try {
      return (await client.query(sql, params)).rows.length > 0;
    } finally {
      client.release();
    }
  }
  const capped = (expiresAt: number) => Math.min(expiresAt, Date.now() + TICKET_SESSION_MAX_MS);

  // Resolves the owner user id, or sends the error response (reply already
  // used) and returns null. An invalid API key falls through to the OAuth
  // check, whose 401 carries the RFC 9728 WWW-Authenticate challenge — one
  // source for that header, whatever the credential was.
  // The guard's handler hands the subject back in the Response body, not via
  // shared state: concurrent requests interleave across the awaits.
  const guard = auth
    ? protectMcpRoute(auth, config, (_request, claims) =>
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
      )
    : null;

  function isRateLimited(error: unknown): boolean {
    return (error as { code?: string } | null | undefined)?.code === "RATE_LIMITED";
  }

  async function tooManyRequests(reply: FastifyReply): Promise<null> {
    await reply.status(429).send({ error: "rate_limited" });
    return null;
  }

  interface Caller {
    owner: string;
    credential: SessionCredential;
  }

  // A widget socket must not outlive the credential that minted its ticket:
  // revoking the key, or the agent's consent (connected-agents revoke deletes
  // the oauthConsent row), makes the next re-check evict it.
  function apiKeyCaller(owner: string, keyId: string): Caller {
    return {
      owner,
      credential: {
        expiresAt: capped(Infinity),
        isValid: () =>
          rowExists(
            `SELECT 1 FROM "apikey" WHERE "id" = $1 AND "enabled" IS NOT FALSE AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
            [keyId],
          ),
      },
    };
  }

  function oauthCaller(claims: { sub: string; exp?: number; clientId?: string }): Caller {
    const { sub, exp, clientId } = claims;
    return {
      owner: sub,
      credential: {
        expiresAt: capped(typeof exp === "number" ? exp * 1000 : Infinity),
        isValid: () =>
          clientId
            ? rowExists(
                `SELECT 1 FROM "oauthConsent" WHERE "userId" = $1 AND "clientId" = $2
                 UNION ALL SELECT 1 FROM "oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2 AND "revoked" IS NULL`,
                [sub, clientId],
              )
            : Promise.resolve(true),
      },
    };
  }

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
    // Set before anything can hijack the reply: @fastify/cors headers never
    // reach a hijacked response, and a 401 needs them too.
    setMcpCorsHeaders(config, request, reply);
    if (!auth || !guard) {
      await reply.status(503).send({ error: "auth_disabled" });
      return null;
    }
    const token = extractBearerToken(request.headers.authorization);
    if (token?.startsWith(API_KEY_PREFIX)) {
      try {
        const verified = await auth.api.verifyApiKey({ body: { key: token } });
        if (verified.valid && verified.key) return apiKeyCaller(verified.key.referenceId, verified.key.id);
        if (isRateLimited(verified.error)) return await tooManyRequests(reply);
      } catch (err) {
        if (isRateLimited((err as { body?: unknown }).body)) return await tooManyRequests(reply);
        request.log.warn({ err }, "[mcp] API key verification failed");
      }
    }
    const response = await guard(toWebRequest(request));
    if (response.status === 200) return oauthCaller(JSON.parse(await response.text()));
    await sendWebResponse(reply, response);
    return null;
  }

  async function handle(request: FastifyRequest, reply: FastifyReply, body?: unknown): Promise<void> {
    const caller = await authenticate(request, reply);
    if (caller === null) return;
    await serveStreamable(request, reply, { owner: caller.owner, appOrigin, widget, credential: caller.credential }, body);
  }

  app.post("/mcp", (request, reply) => handle(request, reply, request.body));
  app.get("/mcp", (request, reply) => handle(request, reply));
  app.delete("/mcp", async (request, reply) => {
    if ((await authenticate(request, reply)) === null) return;
    // Stateless transport: no server-side session to delete.
    return reply.status(204).send();
  });
}
