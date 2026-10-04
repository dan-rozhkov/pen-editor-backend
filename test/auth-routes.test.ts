import { describe, expect, it } from "vitest";
import { API_KEY_RATE_LIMIT, MCP_ACCESS_TOKEN_TTL_SECONDS, protectMcpRoute } from "../src/auth/index.js";
import { sendWebResponse, toWebRequest } from "../src/auth/webBridge.js";
import Fastify from "fastify";
import { makeConfig } from "./helpers.js";
import { APP_ORIGIN, PASSWORD, useAuthApp } from "./authHarness.js";

const app = useAuthApp({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" });

describe("GET /api/auth-config", () => {
  it("reports what is configured", async () => {
    const res = await fetch(`${app().url}/api/auth-config`);
    expect(await res.json()).toEqual({ enabled: true, appOrigin: APP_ORIGIN, google: true, emailEnabled: false });
  });
});

describe("OAuth discovery at the origin root", () => {
  it.each([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/openid-configuration",
  ])("%s advertises S256, CIMD, DCR and RFC 9207", async (path) => {
    const res = await fetch(`${app().url}${path}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: "http://localhost:3001/api/auth",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      registration_endpoint: "http://localhost:3001/api/auth/oauth2/register",
      authorization_response_iss_parameter_supported: true,
      scopes_supported: expect.arrayContaining(["mcp:tools"]),
    });
  });

  it.each(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])(
    "%s names the MCP resource and this authorization server",
    async (path) => {
      const res = await fetch(`${app().url}${path}`);
      expect(await res.json()).toMatchObject({
        resource: "http://localhost:3001/mcp",
        authorization_servers: ["http://localhost:3001/api/auth"],
        scopes_supported: ["mcp:tools"],
      });
    },
  );
});

describe("/api/auth/* catch-all", () => {
  it("refuses password sign-in until the email is verified, then mints a session cookie", async () => {
    const credentials = { email: "verify@example.test", password: PASSWORD, name: "V" };
    await app().fetchAuth("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(credentials) });
    const early = await app().fetchAuth("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify(credentials) });
    expect(early.status).toBe(403);
    expect(early.headers.getSetCookie()).toEqual([]);

    const cookie = await app().signUp("verified@example.test");
    const session = await app().fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } });
    expect((await session.json()).user.email).toBe("verified@example.test");
  });

  it("emails a magic link that signs the user in", async () => {
    const email = "magic@example.test";
    const sent = await app().fetchAuth("/api/auth/sign-in/magic-link", { method: "POST", body: JSON.stringify({ email }) });
    expect(sent.status).toBe(200);
    const link = app().emails.findLast((m) => m.to === email)?.text.match(/https?:\/\/\S+/)?.[0] as string;
    const verified = await app().fetchAuth(new URL(link).pathname + new URL(link).search);
    expect(verified.status).toBe(302);
    expect(verified.headers.getSetCookie().join(";")).toContain("better-auth.session_token=");
  });

  it("rate-limits sign-up per IP and keeps the counters in the database", async () => {
    const attempt = (n: number) =>
      app().fetchAuth("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "X-Forwarded-For": "192.0.2.77" },
        body: JSON.stringify({ email: `rl${n}@example.test`, password: PASSWORD, name: "R" }),
      });
    const statuses: number[] = [];
    for (let n = 0; n < 6; n++) statuses.push((await attempt(n)).status);
    expect(statuses).toContain(429);
    const { rows } = await app().pglite.query(`SELECT 1 FROM "rateLimit"`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("issues API keys with the sf_ prefix that verify server-side to the owner", async () => {
    const cookie = await app().signUp("keys@example.test");
    const created = await app().fetchAuth("/api/auth/api-key/create", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ name: "codex" }),
    });
    const { key } = await created.json();
    expect(key).toMatch(/^sf_/);

    const auth = app().app.auth;
    const verified = await auth?.api.verifyApiKey({ body: { key } });
    expect(verified?.valid).toBe(true);
    const owner = await app().fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } });
    expect(verified?.key?.referenceId).toBe((await owner.json()).user.id);
    expect((await auth?.api.verifyApiKey({ body: { key: "sf_wrong" } }))?.valid).toBe(false);
  });
});

describe("protectMcpRoute", () => {
  it("answers 401 with the RFC 9728 challenge when there is no bearer token", async () => {
    const guarded = protectMcpRoute(app().app.auth!, makeConfig({ BETTER_AUTH_URL: "http://localhost:3001" }), () => new Response("ok"));
    const res = await guarded(new Request("http://localhost:3001/mcp", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost:3001/.well-known/oauth-protected-resource',
    );
  });

  it("rejects a bearer token that is not one of our JWTs", async () => {
    const guarded = protectMcpRoute(app().app.auth!, makeConfig({ BETTER_AUTH_URL: "http://localhost:3001" }), () => new Response("ok"));
    const res = await guarded(new Request("http://localhost:3001/mcp", { headers: { Authorization: "Bearer garbage" } }));
    expect(res.status).toBe(401);
  });
});

describe("Fastify <-> Web bridge", () => {
  it("keeps every Set-Cookie header separate and round-trips method, headers and raw body", async () => {
    const bridge = Fastify();
    bridge.removeAllContentTypeParsers();
    bridge.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    bridge.post("/echo", async (request, reply) => {
      const web = toWebRequest(request);
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1; Path=/; HttpOnly");
      headers.append("set-cookie", "b=2; Path=/; Secure");
      return sendWebResponse(reply, new Response(`${web.method}:${web.headers.get("x-probe")}:${await web.text()}`, { status: 201, headers }));
    });
    const res = await bridge.inject({ method: "POST", url: "/echo", headers: { "x-probe": "p", "content-type": "application/json" }, payload: '{"raw": 1}' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe('POST:p:{"raw": 1}');
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure"]);
    await bridge.close();
  });
});

it("trusts only the frontend origin", () => {
  expect(app().app.auth?.options.trustedOrigins).toEqual([APP_ORIGIN]);
});

describe("trusted client IP and hardening options", () => {
  it("rate-limits on the trusted IP even when the client varies its own X-Forwarded-For", async () => {
    // Fastify (trustProxy) resolves the right-most untrusted entry; a forged
    // left-most value must not mint a fresh rate-limit bucket.
    const statuses: number[] = [];
    for (let n = 0; n < 6; n++) {
      const res = await app().fetchAuth("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "X-Forwarded-For": `203.0.113.${n}, 192.0.2.88` },
        body: JSON.stringify({ email: `spoof${n}@example.test`, password: PASSWORD, name: "S" }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it("overwrites x-forwarded-for with request.ip in the converted Web Request", async () => {
    const bridge = Fastify();
    bridge.get("/ip", async (request) => toWebRequest(request).headers.get("x-forwarded-for"));
    const res = await bridge.inject({ method: "GET", url: "/ip", remoteAddress: "10.1.2.3", headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(res.body).toBe("10.1.2.3");
    await bridge.close();
  });

  it("caches sessions in the cookie for 5 minutes and issues short-lived MCP access tokens", () => {
    const options = app().app.auth?.options;
    expect(options?.session?.cookieCache).toMatchObject({ enabled: true, maxAge: 300 });
    expect(MCP_ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    expect(API_KEY_RATE_LIMIT.maxRequests).toBeGreaterThanOrEqual(600);
  });
});
