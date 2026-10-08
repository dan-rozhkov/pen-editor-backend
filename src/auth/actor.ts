import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPlausibleUserId } from "../lib/userId.js";
import type { Auth, AuthSession } from "./index.js";
import type { Principal } from "../ds/access.js";
import { extractBearerToken } from "../mcp/auth.js";
import type { BearerVerifier } from "./bearer.js";
import { toWebHeaders } from "./webBridge.js";

// `app.auth` is the Better Auth instance, or null when accounts are off
// (isAuthEnabled(config) false). buildApp() decorates the root instance, so
// every encapsulated route plugin sees it.
declare module "fastify" {
  interface FastifyInstance {
    auth: Auth | null;
  }
}

export function getAuth(app: FastifyInstance): Auth | null {
  return app.auth ?? null;
}

/**
 * Who is calling.
 * - `user`: a valid session cookie. Trusted; `userId` is the account id.
 * - `anon`: no session, but the body/query carries a plausible client-generated
 *   `userId` (`pen.userId`) — the pre-accounts trust model, unchanged.
 * - `none`: neither.
 */
export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "anon"; anonId: string }
  | { kind: "none" };

/**
 * Reads the session from the request cookies. Null = signed out (or auth off).
 * `fresh` bypasses Better Auth's cookie cache for a real DB lookup (the editor
 * bridge, where revocation must not lag).
 */
export async function readSession(
  request: FastifyRequest,
  options: { fresh?: boolean } = {},
): Promise<AuthSession | null> {
  const auth = request.server.auth;
  // No cookie header at all can never carry a session: skip the DB round trip
  // that every anonymous chat request would otherwise pay.
  if (!auth || !request.headers.cookie) return null;
  try {
    return await auth.api.getSession({
      headers: toWebHeaders(request.headers),
      ...(options.fresh ? { query: { disableCookieCache: true } } : {}),
    });
  } catch (err) {
    request.log.warn({ err }, "[auth] session lookup failed — treating the caller as signed out");
    return null;
  }
}

function bodyOrQueryUserId(request: FastifyRequest): unknown {
  const body = request.body as { userId?: unknown } | null | undefined;
  const query = request.query as { userId?: unknown } | null | undefined;
  return body?.userId ?? query?.userId;
}

/**
 * A session always wins: a signed-in caller's body `userId` is ignored, so a
 * stale `pen.userId` in localStorage can never write into the anonymous
 * namespace of someone else, or shadow the account's own data.
 */
export async function resolveActor(request: FastifyRequest): Promise<Actor> {
  const session = await readSession(request);
  if (session) return { kind: "user", userId: session.user.id };
  const claimed = bodyOrQueryUserId(request);
  if (typeof claimed === "string" && claimed.length <= 64 && isPlausibleUserId(claimed)) {
    return { kind: "anon", anonId: claimed };
  }
  return { kind: "none" };
}

/** The plain string id stores are keyed by (account id or anon id). */
export function actorId(actor: Actor): string | undefined {
  if (actor.kind === "user") return actor.userId;
  if (actor.kind === "anon") return actor.anonId;
  return undefined;
}

export async function resolveUserId(request: FastifyRequest): Promise<string | undefined> {
  return actorId(await resolveActor(request));
}

/**
 * `resolveUserId` or a 400 (reply already sent, caller returns). For routes
 * where acting without an id is meaningless — the pre-accounts rule was "a
 * shape-invalid userId is a hard 400", and that stays the anonymous behaviour.
 */
export async function requireUserId(
  request: FastifyRequest,
  reply: FastifyReply,
  message = "Invalid or missing userId",
): Promise<string | null> {
  const userId = await resolveUserId(request);
  if (!userId) {
    await reply.status(400).send({ error: message });
    return null;
  }
  return userId;
}

/**
 * The authenticated caller, or a reply already sent (caller returns). For
 * routes whose data is OWNED by an account: unlike `requireUserId` it never
 * accepts a body/query `userId`, because that id is client-generated and
 * unauthenticated, so anyone who knows it could write. 503 when accounts are
 * off, 401 when the caller is anonymous or its credential is bad.
 *
 * A principal is one of: a session cookie (`user`), an `sf_` API key
 * (`api_key`), or an OAuth access token (`agent`). An Authorization bearer
 * header, when present, decides; the cookie is only consulted without one.
 * Pass `verify` (createBearerVerifier) to accept the bearer kinds; without it
 * a bearer header is ignored and only the session counts.
 */
export async function requireAccount(
  request: FastifyRequest,
  reply: FastifyReply,
  verify: BearerVerifier | null = null,
): Promise<Principal | null> {
  if (!request.server.auth) {
    await reply.status(503).send({ error: "auth_disabled", message: "Accounts are not enabled on this server." });
    return null;
  }
  if (verify && extractBearerToken(request.headers.authorization)) {
    const result = await verify(request);
    if (result.ok) {
      return result.kind === "api_key"
        ? { userId: result.userId, kind: "api_key", keyId: result.keyId, scopes: [] }
        : { userId: result.userId, kind: "agent", ...(result.clientId ? { clientId: result.clientId } : {}), scopes: result.scopes };
    }
    if (result.reason === "rate_limited") {
      await reply.status(429).send({ error: "rate_limited", message: "Too many requests. Try again later." });
      return null;
    }
    const challenge = result.response.headers.get("www-authenticate");
    if (challenge) reply.header("WWW-Authenticate", challenge);
    // 403 insufficient_scope stays 403; everything else is a bad credential.
    const status = result.response.status === 403 ? 403 : 401;
    await reply.status(status).send({ error: status === 403 ? "forbidden" : "unauthorized", message: "The access token or API key is not valid for design-system libraries." });
    return null;
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user") {
    await reply.status(401).send({ error: "unauthorized", message: "Sign in to use design-system libraries." });
    return null;
  }
  return { userId: actor.userId, kind: "user", scopes: [] };
}
