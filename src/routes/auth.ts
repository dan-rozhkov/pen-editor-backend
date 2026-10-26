import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import type { Config } from "../config.js";
import { resolveAuthSettings } from "../auth/settings.js";
import { readSession } from "../auth/actor.js";
import { deleteAccount } from "../auth/deleteAccount.js";
import { claimAnonData, type ClaimPool } from "../auth/claim.js";
import { isPlausibleUserId } from "../lib/userId.js";
import { sendWebResponse, toWebHeaders, toWebRequest } from "../auth/webBridge.js";
import type { Auth, AuthSession } from "../auth/index.js";
import { patchRegistrationBody } from "../auth/dcr.js";

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
const deleteBodySchema = z.object({ confirmEmail: z.string().min(1).max(320) });
const claimBodySchema = z.object({ anonId: z.string().min(1).max(64) });

const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const desktopTokenBodySchema = z.object({ challenge: challengeSchema });
const desktopExchangeBodySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  verifier: challengeSchema,
});
// Desktop hand-off tokens live this long (the plugin's own default too).
const DESKTOP_TOKEN_TTL_MS = 3 * 60 * 1000;
const DESKTOP_USER_AGENT = "Sideform Desktop";
// Better Auth's one-time-token plugin keeps its HTTP verify endpoint public;
// a token read off the sideform:// link must never skip the PKCE check.
// Matched on the pathname of the Web Request (dot segments and %2e%2e already
// normalized by `new URL`), not the raw request line. Defense in depth: the
// auth config also lists these in `disabledPaths`.
const isOneTimeTokenPath = (pathname: string): boolean => pathname.toLowerCase().includes("/one-time-token");

function authDisabled(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({ error: "auth_disabled" });
}

/** The signed-in session, or a 401 `sign_in_required` already sent (caller returns). */
async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { fresh?: boolean } = {},
): Promise<AuthSession | null> {
  const session = await readSession(request, options);
  if (!session) await reply.status(401).send({ error: "sign_in_required" });
  return session;
}

/** PKCE S256: base64url (no padding) of SHA-256 over the ASCII verifier. */
export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

function parseHandoff(value: string): { userId: string; challenge: string } | null {
  try {
    const parsed = z.object({ userId: z.string().min(1), challenge: challengeSchema }).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
    // The page origin the browser must match before it sends credentials.
    ...(auth !== null && { appOrigin: settings.appOrigin }),
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

    scope.all("/api/auth/*", async (request, reply) => {
      if (isOneTimeTokenPath(new URL(request.url, "http://x").pathname)) {
        return reply.status(404).send({ error: "not_found" });
      }
      // DCR: loopback-only redirect URIs mean a native client (see auth/dcr.ts).
      if (
        request.method === "POST" &&
        request.url.split("?", 1)[0] === "/api/auth/oauth2/register" &&
        Buffer.isBuffer(request.body)
      ) {
        const patched = patchRegistrationBody(request.body);
        if (patched !== request.body) {
          request.body = patched;
          request.headers["content-length"] = String(patched.length);
        }
      }
      return wellKnown(viaHandler)(request, reply);
    });
  });

  app.post("/api/account/claim-anon", async (request, reply) => {
    if (!auth || !pool) return authDisabled(reply);
    const session = await requireSession(request, reply);
    if (!session) return reply;
    const parsed = claimBodySchema.safeParse(request.body);
    if (!parsed.success || !isPlausibleUserId(parsed.data.anonId)) {
      return reply.status(400).send({ error: "Invalid anonId" });
    }
    const result = await claimAnonData(pool, session.user.id, parsed.data.anonId);
    if (!result.claimed) return reply.status(409).send({ error: result.reason });
    return reply.send({ claimed: true, moved: result.moved });
  });

  // Settings > Delete account. The typed address must match the session's, so
  // a stray click or a stolen-tab replay cannot wipe an account by accident.
  app.post(
    "/api/account/delete",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!auth || !pool) return authDisabled(reply);
      // Fresh: a revoked session must not be able to delete the account.
      const session = await requireSession(request, reply, { fresh: true });
      if (!session) return reply;
      const parsed = deleteBodySchema.safeParse(request.body);
      if (!parsed.success || parsed.data.confirmEmail.trim().toLowerCase() !== session.user.email.toLowerCase()) {
        return reply.status(400).send({ error: "confirm_email_mismatch" });
      }
      let cleanupTraces: () => Promise<void>;
      try {
        ({ cleanupTraces } = await deleteAccount(pool, { id: session.user.id, email: session.user.email }));
      } catch (err) {
        request.log.error({ err }, "[auth] account deletion failed");
        return reply.status(500).send({ error: "delete_failed" });
      }
      // Better Auth's own sign-out produces the clearing Set-Cookie values
      // (name, secure prefix, cross-subdomain Domain). The session row is
      // already gone; sign-out tolerates that and still clears the cookies.
      // Best-effort: the account is already gone, so a failure here must not
      // turn into a 5xx; the dead session cookie is useless anyway.
      try {
        const { headers } = await auth.api.signOut({ headers: toWebHeaders(request.headers), returnHeaders: true });
        const cookies = headers.getSetCookie();
        if (cookies.length > 0) reply.header("set-cookie", cookies);
      } catch (err) {
        request.log.warn({ err }, "[auth] sign-out after account deletion failed");
      }
      // Trace cleanup scans a huge unindexed table: detached, never awaited by
      // the request (cleanupTraces never rejects; the catch is belt and braces).
      void cleanupTraces().catch((err) => request.log.error({ err }, "[auth] trace cleanup failed"));
      return reply.send({ deleted: true });
    },
  );

  // Desktop sign-in (spec 2026-10-20-desktop-sign-in-design.md). The browser
  // trades its session for a one-time token bound to a PKCE challenge, and
  // the desktop app redeems it with the verifier into its OWN session.
  app.post(
    "/api/account/desktop-token",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!auth) return authDisabled(reply);
      // Fresh: a revoked session must not be able to start a hand-off.
      const session = await requireSession(request, reply, { fresh: true });
      if (!session) return reply;
      const parsed = desktopTokenBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_challenge" });
      const { internalAdapter } = await auth.$context;
      // No session yet: it is created at exchange, so an abandoned hand-off
      // leaves nothing live behind.
      const token = randomBytes(32).toString("base64url");
      await internalAdapter.createVerificationValue({
        identifier: `desktop-ott:${token}`,
        value: JSON.stringify({ userId: session.user.id, challenge: parsed.data.challenge }),
        expiresAt: new Date(Date.now() + DESKTOP_TOKEN_TTL_MS),
      });
      return reply.send({ token });
    },
  );

  app.post(
    "/api/account/desktop-exchange",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!auth) return authDisabled(reply);
      const invalid = () => reply.status(400).send({ error: "invalid_token" });
      const parsed = desktopExchangeBodySchema.safeParse(request.body);
      if (!parsed.success) return invalid();
      const { token, verifier } = parsed.data;
      let createdSessionToken: string | null = null;
      const { internalAdapter } = await auth.$context;
      try {
        // Consumed first: a wrong verifier burns the token for good.
        const stored = await internalAdapter.consumeVerificationValue(`desktop-ott:${token}`);
        if (!stored) return invalid();
        const handoff = parseHandoff(stored.value);
        if (!handoff) return invalid();
        const expected = Buffer.from(handoff.challenge, "ascii");
        const actual = Buffer.from(pkceChallenge(verifier), "ascii");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return invalid();
        if (!(await internalAdapter.findUserById(handoff.userId))) return invalid();
        // The desktop's OWN session: signing out in the browser must not sign
        // it out. Created only now that PKCE has passed.
        const desktopSession = await internalAdapter.createSession(handoff.userId, false, {
          userAgent: DESKTOP_USER_AGENT,
          ipAddress: request.ip,
        });
        createdSessionToken = desktopSession.token;
        // Let the plugin's verify set the session cookie exactly as Better
        // Auth would (signing, attributes, cookie-cache data).
        const ott = randomBytes(32).toString("base64url");
        await internalAdapter.createVerificationValue({
          identifier: `one-time-token:${ott}`,
          value: desktopSession.token,
          expiresAt: new Date(Date.now() + 60_000),
        });
        const { headers, response } = await auth.api.verifyOneTimeToken({
          body: { token: ott },
          headers: toWebHeaders(request.headers),
          returnHeaders: true,
        });
        const cookies = headers.getSetCookie();
        if (cookies.length > 0) reply.header("set-cookie", cookies);
        return reply.send({ user: { id: response.user.id, email: response.user.email } });
      } catch (err) {
        request.log.warn({ err }, "[auth] desktop exchange failed");
        // A failure after createSession must not leave a live session behind.
        if (createdSessionToken) {
          await internalAdapter.deleteSession(createdSessionToken).catch((cleanupErr: unknown) => {
            request.log.warn({ err: cleanupErr }, "[auth] desktop exchange cleanup failed");
          });
        }
        return invalid();
      }
    },
  );

  // "Connected agents" page: forget one OAuth client for the signed-in
  // account. Refresh tokens go first so the client cannot mint new access
  // tokens; already-issued JWT access tokens live until they expire
  // (MCP_ACCESS_TOKEN_TTL_SECONDS).
  app.post("/api/account/connected-agents/revoke", async (request, reply) => {
    if (!auth || !pool) return authDisabled(reply);
    const session = await requireSession(request, reply);
    if (!session) return reply;
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
