import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import type { Config } from "../config.js";
import { resolveAuthSettings } from "../auth/settings.js";
import { readSession } from "../auth/actor.js";
import { claimAnonData, type ClaimPool } from "../auth/claim.js";
import { isPlausibleUserId } from "../lib/userId.js";
import { sendWebResponse, toWebRequest } from "../auth/webBridge.js";
import type { Auth } from "../auth/index.js";

// Issuer = `${BETTER_AUTH_URL}/api/auth` (Better Auth's baseURL includes its
// basePath), so RFC 8414 puts the metadata at the origin root WITH the issuer
// path suffix; many MCP clients also probe the suffix-less root form.
const AUTH_SERVER_METADATA_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
];
const OPENID_METADATA_PATHS = ["/.well-known/openid-configuration", "/.well-known/openid-configuration/api/auth"];
// RFC 9728: resource metadata at the origin root, plus the path-suffixed
// variant for a resource served under /mcp. The mcp() plugin answers both.
const PROTECTED_RESOURCE_PATHS = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];

const revokeBodySchema = z.object({ clientId: z.string().min(1).max(512) });
const claimBodySchema = z.object({ anonId: z.string().min(1).max(64) });

function authDisabled(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({ error: "auth_disabled" });
}

export async function authRoutes(
  app: FastifyInstance,
  config: Config,
  auth: Auth | null,
  pool: ClaimPool | null,
): Promise<void> {
  const settings = resolveAuthSettings(config);

  app.get("/api/auth-config", async () => ({
    enabled: auth !== null,
    google: auth !== null && settings.google,
    emailEnabled: auth !== null && settings.emailEnabled,
  }));

  // Encapsulated so the raw-body parser below applies to these routes only.
  await app.register(async (scope) => {
    // Better Auth parses JSON and form bodies itself (and signature checks may
    // need the exact bytes), so hand it the untouched buffer.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

    const wellKnown = (handler: ((request: Request) => Promise<Response>) | null) =>
      async (request: FastifyRequest, reply: FastifyReply) =>
        handler ? sendWebResponse(reply, await handler(toWebRequest(request))) : authDisabled(reply);

    const authServer = auth && oauthProviderAuthServerMetadata(auth);
    const openId = auth && oauthProviderOpenIdConfigMetadata(auth);
    const viaHandler = auth && ((request: Request) => auth.handler(request));
    for (const path of AUTH_SERVER_METADATA_PATHS) scope.get(path, wellKnown(authServer));
    for (const path of OPENID_METADATA_PATHS) scope.get(path, wellKnown(openId));
    for (const path of PROTECTED_RESOURCE_PATHS) scope.get(path, wellKnown(viaHandler));

    scope.all("/api/auth/*", wellKnown(viaHandler));
  });

  app.post("/api/account/claim-anon", async (request, reply) => {
    if (!auth || !pool) return authDisabled(reply);
    const session = await readSession(request);
    if (!session) return reply.status(401).send({ error: "sign_in_required" });
    const parsed = claimBodySchema.safeParse(request.body);
    if (!parsed.success || !isPlausibleUserId(parsed.data.anonId)) {
      return reply.status(400).send({ error: "Invalid anonId" });
    }
    const result = await claimAnonData(pool, session.user.id, parsed.data.anonId);
    if (!result.claimed) return reply.status(409).send({ error: result.reason });
    return reply.send({ claimed: true, moved: result.moved });
  });

  // "Connected agents" page: forget one OAuth client for the signed-in
  // account. Refresh tokens go first so the client cannot mint new access
  // tokens; already-issued JWT access tokens live until they expire
  // (MCP_ACCESS_TOKEN_TTL_SECONDS).
  app.post("/api/account/connected-agents/revoke", async (request, reply) => {
    if (!auth || !pool) return authDisabled(reply);
    const session = await readSession(request);
    if (!session) return reply.status(401).send({ error: "sign_in_required" });
    const parsed = revokeBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid clientId" });
    await revokeConnectedAgent(pool, session.user.id, parsed.data.clientId);
    return reply.send({ revoked: true });
  });
}

// One transaction; table/column names are from migration 016 (the oauth-provider schema).
async function revokeConnectedAgent(pool: ClaimPool, userId: string, clientId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["oauthRefreshToken", "oauthAccessToken", "oauthConsent"]) {
      await client.query(`DELETE FROM "${table}" WHERE "userId" = $1 AND "clientId" = $2`, [userId, clientId]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
