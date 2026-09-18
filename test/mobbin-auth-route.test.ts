import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";

// Real shape of Mobbin's discovery responses, verified live 2026-09-18 —
// Mobbin's authorization server turned out to be Supabase Auth, reached
// only through this two-step discovery, never a hardcoded Supabase host.
const PROTECTED_RESOURCE_METADATA = {
  authorization_servers: ["https://ujasntkfphywizsdaapi.supabase.co/auth/v1"],
};
const AUTH_SERVER_METADATA = {
  registration_endpoint: "https://ujasntkfphywizsdaapi.supabase.co/auth/v1/oauth/clients/register",
  authorization_endpoint: "https://ujasntkfphywizsdaapi.supabase.co/auth/v1/oauth/authorize",
  token_endpoint: "https://ujasntkfphywizsdaapi.supabase.co/auth/v1/oauth/token",
  code_challenge_methods_supported: ["S256", "plain"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  scopes_supported: ["openid", "profile", "email", "phone", "offline_access"],
};

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonCall(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const call = fetchMock.mock.calls[index];
  const init = call?.[1] as { body?: string } | undefined;
  return init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
}

async function buildTestApp(config = makeConfig()): Promise<FastifyInstance> {
  vi.resetModules();
  const { mobbinAuthRoutes } = await import("../src/routes/mobbinAuth.js");
  const app = Fastify({ logger: false });
  await mobbinAuthRoutes(app, config);
  await app.ready();
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/mobbin/register", () => {
  it("discovers Mobbin's OAuth metadata, registers a client, and returns clientId + authorizeEndpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(okJson({ client_id: "dcr-client-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "http://localhost:5173/oauth/mobbin/callback" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      clientId: "dcr-client-1",
      authorizeEndpoint: AUTH_SERVER_METADATA.authorization_endpoint,
    });
    await app.close();
  });

  it("caches the client_id per redirectUri — a second register call for the same URI does not re-run DCR", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(okJson({ client_id: "dcr-client-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const redirectUri = "http://localhost:5173/oauth/mobbin/callback";

    const first = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri },
    });
    expect(first.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3); // resource + as metadata + DCR

    const second = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // Discovery is cached too, so no additional calls at all.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("registers a distinct client_id for a different redirectUri", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(okJson({ client_id: "dcr-client-dev" }))
      .mockResolvedValueOnce(okJson({ client_id: "dcr-client-prod" }));
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(
      makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173,https://app.example.com" }),
    );

    const dev = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "http://localhost:5173/oauth/mobbin/callback" },
    });
    const prod = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "https://app.example.com/oauth/mobbin/callback" },
    });

    expect(dev.json().clientId).toBe("dcr-client-dev");
    expect(prod.json().clientId).toBe("dcr-client-prod");
    await app.close();
  });

  it("rejects a redirectUri whose origin is not in CORS_ALLOWED_ORIGINS with 400, before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "https://evil.example.com/callback" },
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows only localhost/127.0.0.1 when CORS_ALLOWED_ORIGINS is empty (dev default)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: undefined }));

    const rejected = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "https://not-localhost.example.com/callback" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  // Finding 5: URL's `hostname` getter keeps the brackets for a bracketed
  // IPv6 host — `new URL("http://[::1]:5173/x").hostname === "[::1]"`, not
  // "::1" — so a naive `=== "::1"` comparison would never match. This
  // project's own Vite dev server has bound to `[::1]` before (see
  // MEMORY.md's live-check-dev-server-unreachable-from-chrome note), and
  // without this a developer in that situation got a bare 400 with no hint
  // why.
  it("allows IPv6 loopback ([::1]) in the loopback-only fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(okJson({ client_id: "dcr-client-ipv6" }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: undefined }));

    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "http://[::1]:5173/oauth/mobbin/callback" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clientId).toBe("dcr-client-ipv6");
    await app.close();
  });

  it("prefers MOBBIN_REDIRECT_ORIGINS over CORS_ALLOWED_ORIGINS", async () => {
    // Production runs with an empty CORS allowlist, so the redirect allowlist
    // must have its own variable or the OAuth flow is loopback-only there.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(okJson({ client_id: "dcr-client-prod" }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildTestApp(
      makeConfig({
        CORS_ALLOWED_ORIGINS: undefined,
        MOBBIN_REDIRECT_ORIGINS: "https://pen-editor.onrender.com",
      }),
    );

    const allowed = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "https://pen-editor.onrender.com/oauth/mobbin/callback" },
    });
    expect(allowed.statusCode).toBe(200);

    // The CORS fallback must not widen it back out once the dedicated
    // variable is set: loopback is no longer allowed here.
    const rejected = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "http://localhost:5173/oauth/mobbin/callback" },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an allowed origin whose path is not the callback path", async () => {
    // An origin allowlist alone would let any page on that host be the
    // redirect target, including one that forwards its query string onward.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));

    for (const redirectUri of [
      "http://localhost:5173/",
      "http://localhost:5173/some/other/page",
      "http://localhost:5173/oauth/mobbin/callback?next=https://evil.example.com",
      "http://localhost:5173/oauth/mobbin/callback#https://evil.example.com",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/mobbin/register",
        payload: { redirectUri },
      });
      expect(res.statusCode, redirectUri).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  // Finding 12: the frontend router mounts with
  // `basename={import.meta.env.BASE_URL}` and builds the redirect URI as
  // `${origin}${BASE_URL}/oauth/mobbin/callback` — so a deployment with
  // `VITE_BASE=/pen-editor/` produces a redirectUri whose path is
  // `/pen-editor/oauth/mobbin/callback`, not the bare callback path.
  // isAllowedRedirectUri must accept this (suffix match), while every
  // rejection case above (root, an unrelated page, a query string, a
  // fragment) must still be rejected.
  it("accepts an allowed origin whose path carries the frontend's base-path prefix before the callback path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(okJson({ client_id: "dcr-client-base-path" }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));

    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "http://localhost:5173/pen-editor/oauth/mobbin/callback" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clientId).toBe("dcr-client-base-path");
    await app.close();
  });

  it("rejects a missing/malformed redirectUri with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("fails loudly (502) when the authorization server does not support PKCE S256", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(
        okJson({ ...AUTH_SERVER_METADATA, code_challenge_methods_supported: ["plain"] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "http://localhost:5173/oauth/mobbin/callback" },
    });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("never logs or echoes the redirectUri origin failures with any secret-shaped text", async () => {
    // No secret exists yet at register time, but this pins that a discovery
    // failure's error response never carries raw upstream body text (which
    // could in principle echo request parameters).
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));

    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: "http://localhost:5173/oauth/mobbin/callback" },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  // Finding 4: /api/mobbin/register is unauthenticated, and with no
  // allowlist configured, any loopback port is an "allowed" redirectUri
  // (isAllowedRedirectUri's documented dev/prod-fallback behavior) — so
  // without a cap, a caller could grow clientIdByRedirectUri (and trigger
  // one live DCR registration per entry) unboundedly. MAX_CACHED_REDIRECT_
  // CLIENT_IDS (50) bounds that memory, LRU-evicting the least-recently-
  // used entry once exceeded — same shape as the Mobbin MCP client cache.
  it("caps the cached client_id map size — the LRU entry is evicted and re-registers on its next use", async () => {
    const app = await buildTestApp(); // no allowlist configured -> loopback-only, any port
    const redirectUriFor = (port: number) => `http://localhost:${port}/oauth/mobbin/callback`;

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA));
    for (let i = 0; i <= 50; i++) {
      fetchMock.mockResolvedValueOnce(okJson({ client_id: `dcr-client-${i}` }));
    }

    const first = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: redirectUriFor(10_000) },
    });
    expect(first.json().clientId).toBe("dcr-client-0");

    // Fill the cache past its cap (50) with 50 more distinct redirectUris —
    // the first one, never touched again, is the oldest/LRU entry.
    for (let i = 1; i <= 50; i++) {
      await app.inject({
        method: "POST",
        url: "/api/mobbin/register",
        payload: { redirectUri: redirectUriFor(10_000 + i) },
      });
    }

    // Registering the first redirectUri again must re-run DCR (a fresh
    // fetch call) rather than reusing the long-evicted "dcr-client-0".
    fetchMock.mockResolvedValueOnce(okJson({ client_id: "dcr-client-fresh" }));
    const again = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: redirectUriFor(10_000) },
    });
    expect(again.json().clientId).toBe("dcr-client-fresh");
    await app.close();
  });

  // Finding 6 regression: before this fix, a cache HIT never re-inserted
  // its key, so the map was FIFO (evicting by insertion order alone), not
  // LRU as the comment above claimed — a cache hit on the first-inserted
  // entry did nothing to protect it from the next eviction sweep. This test
  // fails on that old behavior: it touches the first entry via a real
  // cache-HIT /register call partway through filling the cache past its
  // cap, and asserts that entry survives while the never-touched entry
  // right after it gets evicted instead.
  it("a cache HIT re-inserts its entry, so it survives an eviction sweep an untouched neighbor does not", async () => {
    const app = await buildTestApp(); // no allowlist configured -> loopback-only, any port
    const redirectUriFor = (port: number) => `http://localhost:${port}/oauth/mobbin/callback`;

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA));
    for (let i = 0; i <= 50; i++) {
      fetchMock.mockResolvedValueOnce(okJson({ client_id: `dcr-client-${i}` }));
    }

    // Entry 0 (first inserted) and entry 1 (second inserted, never touched
    // again) both register fresh.
    const first = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: redirectUriFor(20_000) },
    });
    expect(first.json().clientId).toBe("dcr-client-0");
    const second = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: redirectUriFor(20_001) },
    });
    expect(second.json().clientId).toBe("dcr-client-1");

    // Re-register entry 0 — a genuine cache HIT (no fetch call consumed) —
    // which must move it to the back of the eviction order.
    const touchFirst = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: redirectUriFor(20_000) },
    });
    expect(touchFirst.json().clientId).toBe("dcr-client-0");

    // Fill the cache with 49 more distinct entries. With the cap at 50,
    // that brings the map to 51 non-fresh entries — exactly one over —
    // so exactly one eviction fires, and it must take entry 1 (untouched,
    // now the oldest) rather than entry 0 (touched, no longer the oldest).
    for (let i = 2; i <= 50; i++) {
      await app.inject({
        method: "POST",
        url: "/api/mobbin/register",
        payload: { redirectUri: redirectUriFor(20_000 + i) },
      });
    }

    // Entry 0 survived: registering it again is still a cache hit (no more
    // fetch calls queued beyond what's already been consumed).
    const stillCached = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: redirectUriFor(20_000) },
    });
    expect(stillCached.json().clientId).toBe("dcr-client-0");

    // Entry 1 was evicted: registering it again re-runs DCR.
    fetchMock.mockResolvedValueOnce(okJson({ client_id: "dcr-client-1-fresh" }));
    const evicted = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri: redirectUriFor(20_001) },
    });
    expect(evicted.json().clientId).toBe("dcr-client-1-fresh");
    await app.close();
  });
});

describe("POST /api/mobbin/token", () => {
  it("exchanges the code for tokens using PKCE, requesting the same redirectUri/clientId", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(
        okJson({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/token",
      payload: {
        code: "auth-code-1",
        codeVerifier: "verifier-1",
        clientId: "dcr-client-1",
        redirectUri: "http://localhost:5173/oauth/mobbin/callback",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    const body = jsonCall(fetchMock, 2) as Record<string, string>;
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("auth-code-1");
    expect(body.code_verifier).toBe("verifier-1");
    expect(body.redirect_uri).toBe("http://localhost:5173/oauth/mobbin/callback");
    expect(body.client_id).toBe("dcr-client-1");
    await app.close();
  });

  it("returns refreshToken: null instead of failing when Mobbin/Supabase does not issue one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(okJson({ access_token: "at-1", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/token",
      payload: {
        code: "auth-code-1",
        codeVerifier: "verifier-1",
        clientId: "dcr-client-1",
        redirectUri: "http://localhost:5173/oauth/mobbin/callback",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accessToken: "at-1", refreshToken: null, expiresIn: 3600 });
    await app.close();
  });

  it("rejects a redirectUri outside the allowlist with 400, before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));

    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/token",
      payload: {
        code: "c",
        codeVerifier: "v",
        clientId: "id",
        redirectUri: "https://evil.example.com/callback",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  // Finding 11: a genuine OAuth rejection (the grant itself is dead) must
  // surface as 401, distinct from an infrastructural failure — the
  // frontend's own retry/credential logic treats 401 as terminal (clear
  // stored credentials, prompt reconnect) and anything else as transient.
  it("returns 401, never the upstream body, when Mobbin genuinely rejects the code exchange (invalid_grant)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant", code: "auth-code-1" }), {
          status: 400,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/token",
      payload: {
        code: "auth-code-1",
        codeVerifier: "verifier-1",
        clientId: "dcr-client-1",
        redirectUri: "http://localhost:5173/oauth/mobbin/callback",
      },
    });

    expect(res.statusCode).toBe(401);
    const bodyText = res.body;
    expect(bodyText).not.toContain("auth-code-1");
    expect(bodyText).not.toContain("invalid_grant");
    await app.close();
  });

  it("returns 502 with a generic message, never the upstream body, for an infrastructural exchange failure (no OAuth error code)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      // A bare 500 with no JSON body at all — a real upstream/network
      // failure, not an OAuth rejection.
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/token",
      payload: {
        code: "auth-code-1",
        codeVerifier: "verifier-1",
        clientId: "dcr-client-1",
        redirectUri: "http://localhost:5173/oauth/mobbin/callback",
      },
    });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("rejects a malformed body with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/token",
      payload: { code: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // Finding 5: an `invalid_client` rejection means the DCR registration
  // behind this cached client_id is dead on Mobbin's side. Without
  // invalidating the cache entry, every subsequent /register call for the
  // SAME redirectUri would keep handing out the same dead id, and every
  // /token call would keep failing the same way forever (no self-healing
  // path otherwise, since client_id is cached for the process lifetime).
  it("invalidates the cached client_id on invalid_client, so the NEXT /register call re-registers instead of reusing the dead id", async () => {
    const app = await buildTestApp(makeConfig({ CORS_ALLOWED_ORIGINS: "http://localhost:5173" }));
    const redirectUri = "http://localhost:5173/oauth/mobbin/callback";

    // 1. Register once — caches "dcr-client-dead".
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
        .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
        .mockResolvedValueOnce(okJson({ client_id: "dcr-client-dead" })),
    );
    const registered = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri },
    });
    expect(registered.json().clientId).toBe("dcr-client-dead");

    // 2. /token fails with invalid_client — the cached id is dead.
    // (Discovery metadata is already cached from step 1, so this stub only
    // needs to answer the token-endpoint call.)
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
        ),
    );
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/mobbin/token",
      payload: {
        code: "c",
        codeVerifier: "v",
        clientId: "dcr-client-dead",
        redirectUri,
      },
    });
    expect(tokenRes.statusCode).toBe(401);

    // 3. /register for the SAME redirectUri must now re-register, not
    // reuse the dead cached id.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(okJson({ client_id: "dcr-client-fresh" })),
    );
    const reregistered = await app.inject({
      method: "POST",
      url: "/api/mobbin/register",
      payload: { redirectUri },
    });
    expect(reregistered.json().clientId).toBe("dcr-client-fresh");
    await app.close();
  });
});

describe("POST /api/mobbin/refresh", () => {
  it("exchanges a refresh token for a new access token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(
        okJson({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/refresh",
      payload: { refreshToken: "rt-old", clientId: "dcr-client-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 });
    const body = jsonCall(fetchMock, 2) as Record<string, string>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("rt-old");
    expect(body.client_id).toBe("dcr-client-1");
    await app.close();
  });

  it("never logs the refresh token or access token text on failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/refresh",
      payload: { refreshToken: "super-secret-refresh-token", clientId: "dcr-client-1" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("super-secret-refresh-token");
    await app.close();
  });

  // Finding 11: a dead refresh token (invalid_grant) is a TERMINAL
  // rejection — Mobbin/Supabase is saying "this credential will never work
  // again", which must reach the frontend as 401 so it clears the stored
  // refresh token instead of retrying it forever.
  it("returns 401 when Mobbin rejects the refresh grant itself (invalid_grant)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(PROTECTED_RESOURCE_METADATA))
      .mockResolvedValueOnce(okJson(AUTH_SERVER_METADATA))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/refresh",
      payload: { refreshToken: "dead-refresh-token", clientId: "dcr-client-1" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("dead-refresh-token");
    await app.close();
  });

  it("rejects a malformed body with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/mobbin/refresh",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
