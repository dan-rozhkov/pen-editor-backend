import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { credentialHeaders, isCredentialedOrigin } from "../src/plugins/cors.js";
import { startApp } from "./chatHarness.js";
import { makeConfig } from "./helpers.js";

const APP = "https://app.sideform.pro";
const OTHER = "https://other.example";
const EVIL = "https://evil.example";

async function corsHeaders(overrides: Partial<Config>, origin: string, method = "GET") {
  const running = await startApp(makeConfig(overrides));
  try {
    const res = await fetch(`${running.url}/api/auth-config`, {
      method,
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    });
    return {
      origin: res.headers.get("access-control-allow-origin"),
      credentials: res.headers.get("access-control-allow-credentials"),
      headers: res.headers.get("access-control-allow-headers"),
    };
  } finally {
    await running.close();
  }
}

describe("CORS credentials", () => {
  it("reflects an allowlisted origin WITH credentials", async () => {
    expect(await corsHeaders({ CORS_ALLOWED_ORIGINS: `${APP},${OTHER}` }, APP)).toMatchObject({
      origin: APP,
      credentials: "true",
    });
  });

  it("reflects APP_ORIGIN with credentials even when the allowlist omits it", async () => {
    expect(await corsHeaders({ APP_ORIGIN: APP, CORS_ALLOWED_ORIGINS: OTHER }, APP)).toMatchObject({
      origin: APP,
      credentials: "true",
    });
  });

  it("never gives a foreign origin credentials, and does not reflect it past an allowlist", async () => {
    expect(await corsHeaders({ CORS_ALLOWED_ORIGINS: APP }, EVIL)).toEqual({ origin: null, credentials: null, headers: null });
  });

  it("keeps the empty-allowlist dev behaviour (reflect) but without credentials", async () => {
    expect(await corsHeaders({}, EVIL)).toMatchObject({ origin: EVIL, credentials: null });
    expect(await corsHeaders({ APP_ORIGIN: APP }, EVIL)).toMatchObject({ origin: EVIL, credentials: null });
  });

  it("answers the preflight with the existing allowed headers", async () => {
    const preflight = await corsHeaders({ CORS_ALLOWED_ORIGINS: APP }, APP, "OPTIONS");
    expect(preflight).toMatchObject({ origin: APP, credentials: "true" });
    expect(preflight.headers).toBe("Content-Type, Authorization, Mcp-Session-Id, X-OpenCode-Key, X-Mobbin-Token");
  });
});

describe("isCredentialedOrigin / credentialHeaders (hijacked SSE replies)", () => {
  it("is true only for named origins", () => {
    const config = makeConfig({ APP_ORIGIN: `${APP}/`, CORS_ALLOWED_ORIGINS: OTHER });
    expect([APP, OTHER, EVIL, undefined].map((o) => isCredentialedOrigin(config, o))).toEqual([true, true, false, false]);
    expect(credentialHeaders(config, APP)).toEqual({ "Access-Control-Allow-Credentials": "true" });
    expect(credentialHeaders(config, EVIL)).toEqual({});
  });

  it("treats the localhost dev frontend as named once accounts are on without APP_ORIGIN", () => {
    const on = makeConfig({ BETTER_AUTH_SECRET: "s".repeat(32), TRACE_DATABASE_URL: "postgres://x" });
    expect(isCredentialedOrigin(on, "http://localhost:5173")).toBe(true);
    expect(isCredentialedOrigin(makeConfig(), "http://localhost:5173")).toBe(false);
  });
});
