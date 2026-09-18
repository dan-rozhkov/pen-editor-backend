// Backend proxy for Mobbin's OAuth 2.1 flow (Dynamic Client Registration +
// PKCE S256, scope `openid offline_access`). See
// docs/superpowers/specs/2026-09-18-mobbin-mcp-design.md for the full design.
//
// The backend holds NO credential state across requests beyond two small,
// non-secret, in-memory caches (OAuth server metadata, and a DCR client_id
// per redirect URI). Every access/refresh token this route ever sees is
// handed straight back to the browser and never written anywhere — no
// table, no per-user row, no log line. `code`/`codeVerifier`/`accessToken`/
// `refreshToken` must never appear in a `console.log`/`request.log` call or
// in a response's `error` field.
//
// Real discovery, verified live 2026-09-18 against api.mobbin.com: Mobbin's
// authorization server is Supabase Auth (currently at
// `https://ujasntkfphywizsdaapi.supabase.co/auth/v1`), reached ONLY through
// the two-step discovery below — that Supabase host is never hardcoded here,
// since it's an infrastructure detail of Mobbin's that can change without
// notice. The only hardcoded URL is the entry point itself
// (MOBBIN_PROTECTED_RESOURCE_URL).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseEnvList, type Config } from "../config.js";

const MOBBIN_PROTECTED_RESOURCE_URL =
  "https://api.mobbin.com/.well-known/oauth-protected-resource/mcp";

// Requested at DCR time (registerDynamicClient) — the actual authorize-URL
// scope string is assembled by the frontend (this route only hands back
// `authorizeEndpoint`, not a fully-built authorize URL), but requesting the
// same scope at registration keeps the client's registered scope from
// disagreeing with what it will later ask for. `offline_access` matters
// specifically because Mobbin's authorization server is Supabase Auth,
// which — like most OIDC providers — does not reliably issue a
// `refresh_token` for a bare `openid` scope. Without it, `/api/mobbin/refresh`
// would be dead code and every user would have to re-authorize on every
// token expiry.
const MOBBIN_OAUTH_SCOPE = "openid offline_access";

const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;

// Fetches AND reads the JSON body under ONE deadline. `clearTimeout` used to
// live in a `finally` wrapped only around the `fetch()` call — that fires
// the instant HEADERS arrive, which is well before the body is read, so an
// upstream that sends headers and then stalls mid-body had no deadline at
// all on the read that follows (every caller below calls `res.json()` after
// getting the Response back). Reading the body here too, inside the same
// try/finally, means the abort signal — and therefore the timeout — stays
// armed through the read as well. `json` is `undefined` if the body isn't
// valid JSON (e.g. an empty error response) rather than throwing, since a
// caller on the error path still needs `res.ok`/`res.status` even when
// there was no parseable body.
async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

interface MobbinOAuthMetadata {
  registrationEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

// Process-level cache: this metadata is static server configuration, never
// per-user, so there is nothing wrong with holding it for the life of the
// process. A failed discovery is NOT cached — the `.catch` below clears the
// slot so the next request retries against a possibly-recovered upstream.
let discoveryCache: Promise<MobbinOAuthMetadata> | null = null;

async function fetchDiscoveryJson(url: string): Promise<Record<string, unknown>> {
  const { res, json } = await fetchJsonWithTimeout(url, {}, DISCOVERY_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`Discovery request to ${url} failed: HTTP ${res.status}`);
  }
  return (json ?? {}) as Record<string, unknown>;
}

function discoverMobbinOAuth(): Promise<MobbinOAuthMetadata> {
  if (!discoveryCache) {
    discoveryCache = (async () => {
      const resource = await fetchDiscoveryJson(MOBBIN_PROTECTED_RESOURCE_URL);
      const authServers = resource.authorization_servers;
      const authServer = Array.isArray(authServers) ? authServers[0] : undefined;
      if (typeof authServer !== "string" || !authServer) {
        throw new Error(
          "Mobbin's protected-resource metadata did not include an authorization server",
        );
      }

      // The authorization server's own metadata document — this is where
      // Mobbin's actual (Supabase-hosted, subject to change) OAuth endpoints
      // come from. Never hardcoded.
      const asMetadataUrl = `${authServer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
      const asMetadata = await fetchDiscoveryJson(asMetadataUrl);

      const registrationEndpoint = asMetadata.registration_endpoint;
      const authorizationEndpoint = asMetadata.authorization_endpoint;
      const tokenEndpoint = asMetadata.token_endpoint;
      if (
        typeof registrationEndpoint !== "string" ||
        typeof authorizationEndpoint !== "string" ||
        typeof tokenEndpoint !== "string"
      ) {
        throw new Error(
          "Mobbin's authorization-server metadata is missing a required OAuth endpoint",
        );
      }

      const codeChallengeMethods = asMetadata.code_challenge_methods_supported;
      if (!Array.isArray(codeChallengeMethods) || !codeChallengeMethods.includes("S256")) {
        // `plain` is not acceptable — PKCE without S256 defeats the point of
        // PKCE for a public client. Fail loudly rather than silently falling
        // back to a weaker method.
        throw new Error(
          "Mobbin's authorization server does not advertise PKCE S256 support " +
            `(code_challenge_methods_supported: ${JSON.stringify(codeChallengeMethods)})`,
        );
      }

      return { registrationEndpoint, authorizationEndpoint, tokenEndpoint };
    })();
    discoveryCache.catch(() => {
      discoveryCache = null;
    });
  }
  return discoveryCache;
}

// client_id is not a secret and is not per-user, but IS per-redirect-URI
// (dev and prod origins register separately) — cached in memory rather than
// re-registering a new DCR client on every /register call.
//
// Bounded, because /api/mobbin/register is unauthenticated: with an empty
// MOBBIN_REDIRECT_ORIGINS/CORS_ALLOWED_ORIGINS (the documented prod
// fallback — isAllowedRedirectUri), every loopback host on any port is an
// "allowed" redirectUri, so a caller could otherwise grow this map by one
// entry (and trigger one live DCR registration against Mobbin) per port,
// unbounded. Capped the same way the Mobbin MCP client cache is
// (src/ai/mcp.ts) — small eviction, insertion order doubles as eviction
// order, and (like that cache's `touch()`) a HIT re-inserts the key so it
// isn't evicted ahead of an entry nobody has asked for since — see
// touchClientId below, called on every cache hit in the route handler. The
// registerRateLimit config on the route below bounds the RATE of new
// entries; this bounds how much memory (and how many live upstream
// registrations) an unbounded burst could ever cost.
const MAX_CACHED_REDIRECT_CLIENT_IDS = 50;
const clientIdByRedirectUri = new Map<string, string>();

function cacheClientId(redirectUri: string, clientId: string): void {
  clientIdByRedirectUri.delete(redirectUri);
  clientIdByRedirectUri.set(redirectUri, clientId);
  while (clientIdByRedirectUri.size > MAX_CACHED_REDIRECT_CLIENT_IDS) {
    const oldestKey = clientIdByRedirectUri.keys().next().value;
    if (oldestKey === undefined) break;
    clientIdByRedirectUri.delete(oldestKey);
  }
}

// Re-inserts an existing entry so it becomes the newest for eviction
// purposes — mirrors src/ai/mcp.ts's own `touch()` for its MCP client cache.
// Without this, a cache HIT never moved a key to the back of the Map's
// insertion order, so an actively-reused redirectUri could still be the
// "oldest" entry (by insertion time) and get evicted by cacheClientId's LRU
// sweep ahead of a redirectUri nobody has asked for since it was first
// registered — the exact FIFO-not-LRU gap this function closes.
function touchClientId(redirectUri: string, clientId: string): void {
  clientIdByRedirectUri.delete(redirectUri);
  clientIdByRedirectUri.set(redirectUri, clientId);
}

// Removes any redirectUri entries pointing at `clientId` — called when
// Mobbin's token endpoint rejects a request with `invalid_client`, which
// means the DCR registration behind this cached id is dead (deleted,
// expired, rotated on Mobbin's side). Without this, every subsequent
// /token or /refresh call using this same cached client_id fails the same
// way until the process restarts — there is otherwise no self-healing path
// since client_id is cached for the life of the process.
function invalidateClientId(clientId: string): void {
  for (const [uri, id] of clientIdByRedirectUri) {
    if (id === clientId) clientIdByRedirectUri.delete(uri);
  }
}

class TokenExchangeError extends Error {
  constructor(
    message: string,
    public readonly oauthErrorCode?: string,
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }
}

// Finding 11: a 502 from /token or /refresh used to mean BOTH "Mobbin
// genuinely rejected this grant, it is dead, reconnect" and "something
// infrastructural went wrong" (discovery timeout, network blip, a 5xx from
// Mobbin) — indistinguishable to the frontend. Its own retry/credential
// logic (see the design doc) treats 401 as terminal (clear stored
// credentials, prompt reconnect) and anything else as transient (keep
// credentials, retry later) — so a genuine rejection has to actually reach
// it as a 401, or that branch is unreachable and a dead refresh token gets
// retried forever. `invalid_grant` (the refresh token itself is
// dead/expired/revoked) and `invalid_client` (the DCR registration behind
// it is dead — see invalidateClientId above) are the two standard OAuth
// token-endpoint error codes that mean the GRANT is permanently unusable,
// as opposed to a transient exchange problem. Everything else — including
// an upstream HTTP error with no parseable `error` field at all — stays
// infrastructural (502).
const TERMINAL_OAUTH_ERROR_CODES = new Set(["invalid_grant", "invalid_client"]);

function isTerminalOAuthRejection(err: unknown): boolean {
  return (
    err instanceof TokenExchangeError &&
    err.oauthErrorCode !== undefined &&
    TERMINAL_OAUTH_ERROR_CODES.has(err.oauthErrorCode)
  );
}

async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const { res, json } = await fetchJsonWithTimeout(
    registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        // Public client: PKCE is the only proof of possession, there is no
        // client secret to leak or rotate.
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: MOBBIN_OAUTH_SCOPE,
      }),
    },
    DISCOVERY_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`Mobbin's registration endpoint returned HTTP ${res.status}`);
  }
  const body = json as { client_id?: unknown } | undefined;
  if (!body || typeof body.client_id !== "string" || !body.client_id) {
    throw new Error("Mobbin's registration endpoint did not return a client_id");
  }
  return body.client_id;
}

interface TokenResult {
  accessToken: string;
  // Not guaranteed: Supabase Auth (Mobbin's authorization server) may
  // decline to issue one even with `offline_access` requested. `null`
  // (never a thrown error) tells the frontend to prompt the user to
  // reconnect on next expiry instead of retrying a refresh call that was
  // always going to fail.
  refreshToken: string | null;
  expiresIn: number | null;
}

async function requestToken(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<TokenResult> {
  const { res, json } = await fetchJsonWithTimeout(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    },
    TOKEN_TIMEOUT_MS,
  );
  if (!res.ok) {
    // The error MESSAGE deliberately never carries the response body: some
    // authorization servers echo request parameters (a code, a client_id)
    // back into `error_description`, and nothing upstream-supplied should
    // ever reach a log line or the client via this path. The narrow `error`
    // enum field (e.g. "invalid_client", "invalid_grant" — a fixed OAuth
    // vocabulary, never free text) is the one exception: read internally,
    // used only to decide whether to invalidate a dead cached client_id
    // below, and never itself logged or returned to the caller.
    const body = json as { error?: unknown } | undefined;
    const oauthErrorCode = typeof body?.error === "string" ? body.error : undefined;
    throw new TokenExchangeError(
      `Mobbin's token endpoint returned HTTP ${res.status}`,
      oauthErrorCode,
    );
  }
  const body = json as
    | { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
    | undefined;
  if (!body || typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Mobbin's token endpoint did not return an access_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
  };
}

// redirectUri is an open redirect into a real OAuth flow if left
// unconstrained — restricted to the same origin allowlist
// src/plugins/cors.ts derives from CORS_ALLOWED_ORIGINS. An empty allowlist
// (local dev, mirroring registerCors's own "empty = allow any origin"
// stance for CORS) is still restricted to loopback here, since an open
// redirect is a strictly worse failure mode than a permissive CORS policy.
// The one path the editor's OAuth popup ever lands on. Pinning it means an
// allowed origin cannot be turned into an open redirect via some other page
// on the same host that happens to forward its query string onward — the
// origin allowlist alone would permit that.
//
// Matched by SUFFIX, not exact equality: the frontend router mounts with
// `basename={import.meta.env.BASE_URL}` (see pen-editor's AppRouter.tsx)
// and builds the redirect URI as `${origin}${BASE_URL}/oauth/mobbin/callback`
// — so a deployment that sets `VITE_BASE=/pen-editor/` produces
// `/pen-editor/oauth/mobbin/callback`, which an exact-equality check would
// reject with a bare 400. Today's default build (`BASE_URL` unset, i.e.
// `/`) is unaffected either way, so this was a latent mismatch rather than
// a live break. Suffix matching keeps the actual security property intact:
// the origin still has to be in the allowlist (so this is a build-time
// prefix the DEPLOYER controls, not something an attacker can inject), and
// query string/fragment/credentials in the URL are still rejected below —
// an allowed origin still can't be turned into an open redirect through
// some other page that happens to end in this same suffix and forwards its
// query string onward.
const MOBBIN_CALLBACK_PATH = "/oauth/mobbin/callback";

function isAllowedRedirectUri(redirectUri: string, allowedOrigins: string[]): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  // Credentials in the URL, a query string or a fragment have no legitimate
  // place in this redirect target and are all ways to smuggle something past
  // an origin check.
  if (!url.pathname.endsWith(MOBBIN_CALLBACK_PATH)) return false;
  if (url.search || url.hash || url.username || url.password) return false;
  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(url.origin);
  }
  // Loopback-only fallback. http is tolerated here (and only here) because a
  // local dev server has no certificate. IPv6 loopback included: this
  // project's own Vite dev server has bound to `http://[::1]:5173` before
  // (see MEMORY.md's live-check-dev-server-unreachable-from-chrome note) —
  // URL's `hostname` getter keeps the brackets for a bracketed IPv6 literal
  // host (`new URL("http://[::1]:5173").hostname === "[::1]"`, verified
  // against Node's URL implementation), so the comparison must include them
  // rather than comparing against the bare "::1".
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return isLoopback;
}

const registerBodySchema = z.object({ redirectUri: z.string().url() });
const tokenBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
});
const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
  clientId: z.string().min(1),
});

export async function mobbinAuthRoutes(app: FastifyInstance, config: Config): Promise<void> {
  // MOBBIN_REDIRECT_ORIGINS first, CORS_ALLOWED_ORIGINS as the fallback. The
  // deployed backend runs with an empty CORS allowlist (verified against
  // production: it reflects an arbitrary Origin header back), so deriving the
  // redirect allowlist from that variable alone would leave production
  // restricted to loopback — nobody could ever complete the OAuth flow, and
  // the only symptom would be a 400 from /api/mobbin/register.
  const allowedOrigins =
    parseEnvList(config.MOBBIN_REDIRECT_ORIGINS).length > 0
      ? parseEnvList(config.MOBBIN_REDIRECT_ORIGINS)
      : parseEnvList(config.CORS_ALLOWED_ORIGINS);

  if (allowedOrigins.length === 0) {
    console.warn(
      "[mobbin-auth] Neither MOBBIN_REDIRECT_ORIGINS nor CORS_ALLOWED_ORIGINS is set — " +
        "the Mobbin OAuth redirect allowlist is restricted to loopback, so connecting " +
        "Mobbin will fail for every non-local origin.",
    );
  }

  app.post(
    "/api/mobbin/register",
    // Unauthenticated route: without a per-IP cost guard, a caller could
    // hammer this with distinct redirectUris (any loopback port passes
    // isAllowedRedirectUri when no allowlist is configured) and trigger one
    // live DCR registration against Mobbin per request — see
    // MAX_CACHED_REDIRECT_CLIENT_IDS above for the companion memory cap.
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = registerBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid or missing redirectUri" });
      }
      const { redirectUri } = parsed.data;
      if (!isAllowedRedirectUri(redirectUri, allowedOrigins)) {
        return reply.status(400).send({ error: "redirectUri is not an allowed origin" });
      }

      let metadata: MobbinOAuthMetadata;
      try {
        metadata = await discoverMobbinOAuth();
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : String(err) });
        return reply
          .status(502)
          .send({ error: "Failed to discover Mobbin's OAuth configuration" });
      }

      let clientId = clientIdByRedirectUri.get(redirectUri);
      if (!clientId) {
        try {
          clientId = await registerDynamicClient(metadata.registrationEndpoint, redirectUri);
        } catch (err) {
          request.log.error({ err: err instanceof Error ? err.message : String(err) });
          return reply
            .status(502)
            .send({ error: "Failed to register an OAuth client with Mobbin" });
        }
        cacheClientId(redirectUri, clientId);
      } else {
        // Cache HIT: re-insert so this actively-reused redirectUri counts
        // as the newest entry, not the one evicted next — see
        // touchClientId's doc comment.
        touchClientId(redirectUri, clientId);
      }

      return reply.send({ clientId, authorizeEndpoint: metadata.authorizationEndpoint });
    },
  );

  app.post(
    "/api/mobbin/token",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = tokenBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid token exchange request" });
      }
      const { code, codeVerifier, clientId, redirectUri } = parsed.data;
      if (!isAllowedRedirectUri(redirectUri, allowedOrigins)) {
        return reply.status(400).send({ error: "redirectUri is not an allowed origin" });
      }

      let metadata: MobbinOAuthMetadata;
      try {
        metadata = await discoverMobbinOAuth();
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : String(err) });
        return reply
          .status(502)
          .send({ error: "Failed to discover Mobbin's OAuth configuration" });
      }

      try {
        const result = await requestToken(metadata.tokenEndpoint, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: codeVerifier,
        });
        return reply.send(result);
      } catch (err) {
        // A dead cached client_id (Mobbin deleted/rotated the DCR
        // registration) would otherwise fail every /token call using it
        // the same way until process restart — there is no other
        // self-healing path since client_id is cached for the process
        // lifetime. Drop it so the NEXT /register call re-registers fresh.
        if (err instanceof TokenExchangeError && err.oauthErrorCode === "invalid_client") {
          invalidateClientId(clientId);
        }
        // Free-plan accounts complete OAuth successfully — Mobbin's docs say
        // the plan gate only fires at tool-call time, not here — so a failure
        // at this step is a genuine exchange problem (expired code, clock
        // skew, wrong client), not a plan issue. We don't fabricate a plan
        // signal Mobbin never gave us.
        request.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[mobbin-auth] token exchange failed",
        );
        if (isTerminalOAuthRejection(err)) {
          return reply.status(401).send({
            error:
              "Mobbin rejected the authorization code exchange. The code may have expired — try connecting again.",
          });
        }
        return reply.status(502).send({
          error: "Failed to exchange the authorization code with Mobbin. Please try again.",
        });
      }
    },
  );

  app.post(
    "/api/mobbin/refresh",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = refreshBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid refresh request" });
      }
      const { refreshToken, clientId } = parsed.data;

      let metadata: MobbinOAuthMetadata;
      try {
        metadata = await discoverMobbinOAuth();
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : String(err) });
        return reply
          .status(502)
          .send({ error: "Failed to discover Mobbin's OAuth configuration" });
      }

      try {
        const result = await requestToken(metadata.tokenEndpoint, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof TokenExchangeError && err.oauthErrorCode === "invalid_client") {
          invalidateClientId(clientId);
        }
        request.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[mobbin-auth] refresh failed",
        );
        if (isTerminalOAuthRejection(err)) {
          return reply.status(401).send({
            error: "Mobbin rejected the refresh token. Reconnect your Mobbin account.",
          });
        }
        return reply.status(502).send({
          error: "Failed to refresh the Mobbin access token. Please try again.",
        });
      }
    },
  );
}
