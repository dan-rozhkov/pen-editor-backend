import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { API_KEY_PREFIX, protectMcpRoute, type Auth } from "../auth/index.js";
import { resolveAuthSettings } from "../auth/settings.js";
import { sendWebResponse, toWebRequest } from "../auth/webBridge.js";
import { setMcpCorsHeaders } from "../plugins/cors.js";
import { extractBearerToken } from "./auth.js";
import { serveStreamable } from "./streamable.js";

// The account-scoped remote MCP endpoint (`/mcp`). Same tool surface as the
// legacy `/api/mcp`, but the caller is an account: an OAuth access token or an
// `sf_` API key, never the shared static token. The resolved user id is the
// bridge owner, so bridged calls only reach that user's own editor tabs.
export async function remoteMcpRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const auth: Auth | null = app.auth;
  const { appOrigin } = resolveAuthSettings(config);

  // Resolves the owner user id, or sends the error response (reply already
  // used) and returns null. An invalid API key falls through to the OAuth
  // check, whose 401 carries the RFC 9728 WWW-Authenticate challenge — one
  // source for that header, whatever the credential was.
  // The guard's handler hands the subject back in the Response body, not via
  // shared state: concurrent requests interleave across the awaits.
  const guard = auth
    ? protectMcpRoute(auth, config, (_request, claims) =>
        typeof claims.sub === "string" && claims.sub
          ? new Response(claims.sub, { status: 200 })
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

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
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
        if (verified.valid && verified.key) return verified.key.referenceId;
        if (isRateLimited(verified.error)) return await tooManyRequests(reply);
      } catch (err) {
        if (isRateLimited((err as { body?: unknown }).body)) return await tooManyRequests(reply);
        request.log.warn({ err }, "[mcp] API key verification failed");
      }
    }
    const response = await guard(toWebRequest(request));
    if (response.status === 200) return await response.text();
    await sendWebResponse(reply, response);
    return null;
  }

  async function handle(request: FastifyRequest, reply: FastifyReply, body?: unknown): Promise<void> {
    const owner = await authenticate(request, reply);
    if (owner === null) return;
    await serveStreamable(request, reply, { owner, appOrigin }, body);
  }

  app.post("/mcp", (request, reply) => handle(request, reply, request.body));
  app.get("/mcp", (request, reply) => handle(request, reply));
  app.delete("/mcp", async (request, reply) => {
    if ((await authenticate(request, reply)) === null) return;
    // Stateless transport: no server-side session to delete.
    return reply.status(204).send();
  });
}
