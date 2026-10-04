import { describe, expect, it } from "vitest";
import { envSchema, isAuthEnabled } from "../src/config.js";
import { resolveAuthSettings } from "../src/auth/settings.js";
import { createEmailSender, magicLinkMessage } from "../src/auth/email.js";
import { startApp } from "./chatHarness.js";
import { makeConfig } from "./helpers.js";

const SECRET = "s".repeat(32);

describe("isAuthEnabled", () => {
  it.each([
    [{ BETTER_AUTH_SECRET: SECRET, TRACE_DATABASE_URL: "postgres://x" }, true],
    [{ BETTER_AUTH_SECRET: SECRET, TRACE_DATABASE_URL: undefined }, false],
    [{ BETTER_AUTH_SECRET: undefined, TRACE_DATABASE_URL: "postgres://x" }, false],
    [{ BETTER_AUTH_SECRET: undefined, TRACE_DATABASE_URL: undefined }, false],
  ])("%j -> %s", (config, expected) => {
    expect(isAuthEnabled(config)).toBe(expected);
  });
});

describe("account env vars", () => {
  it("treats blank values as unset", () => {
    const parsed = envSchema.parse({
      OPENROUTER_API_KEY: "k",
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: "",
      GOOGLE_CLIENT_ID: "",
    });
    expect(parsed.BETTER_AUTH_SECRET).toBeUndefined();
    expect(parsed.BETTER_AUTH_URL).toBeUndefined();
    expect(parsed.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it("rejects a short secret and a non-URL origin", () => {
    const base = { OPENROUTER_API_KEY: "k" };
    expect(envSchema.safeParse({ ...base, BETTER_AUTH_SECRET: "short" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, APP_ORIGIN: "not a url" }).success).toBe(false);
  });
});

describe("resolveAuthSettings", () => {
  it("falls back to localhost origins and a /mcp resource under the base URL", () => {
    const settings = resolveAuthSettings(makeConfig({ PORT: 4000 }));
    expect(settings).toMatchObject({
      baseUrl: "http://localhost:4000",
      appOrigin: "http://localhost:5173",
      mcpResource: "http://localhost:4000/mcp",
      google: false,
      emailEnabled: false,
    });
  });

  it("strips trailing slashes, honours MCP_RESOURCE_URL and detects providers", () => {
    const settings = resolveAuthSettings(
      makeConfig({
        BETTER_AUTH_URL: "https://api.sideform.pro/",
        APP_ORIGIN: "https://app.sideform.pro/",
        MCP_RESOURCE_URL: "https://api.sideform.pro/custom-mcp",
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        RESEND_API_KEY: "re_x",
        EMAIL_FROM: "Sideform <no-reply@sideform.pro>",
      }),
    );
    expect(settings).toEqual({
      baseUrl: "https://api.sideform.pro",
      appOrigin: "https://app.sideform.pro",
      mcpResource: "https://api.sideform.pro/custom-mcp",
      google: true,
      emailEnabled: true,
    });
  });

  it("needs both Google values and both email values", () => {
    const half = resolveAuthSettings(makeConfig({ GOOGLE_CLIENT_ID: "id", RESEND_API_KEY: "re_x" }));
    expect(half.google).toBe(false);
    expect(half.emailEnabled).toBe(false);
  });
});

describe("email sender", () => {
  it("logs the message instead of sending when Resend is not configured", async () => {
    const lines: string[] = [];
    await createEmailSender({}, (line) => lines.push(line))(magicLinkMessage("a@b.test", "https://x.test/link"));
    expect(lines.join("\n")).toContain("https://x.test/link");
    expect(lines.join("\n")).toContain("a@b.test");
  });

  it("escapes the link in the HTML body", () => {
    const message = magicLinkMessage("a@b.test", 'https://x.test/?a=1&b="2"');
    expect(message.html).toContain("a=1&amp;b=&quot;2&quot;");
    expect(message.text).toContain('a=1&b="2"');
  });
});

describe("auth off", () => {
  it("answers /api/auth-config {enabled:false} and 503 auth_disabled everywhere else", async () => {
    const app = await startApp(makeConfig());
    try {
      const config = await fetch(`${app.url}/api/auth-config`);
      expect(await config.json()).toEqual({ enabled: false, google: false, emailEnabled: false });
      for (const [method, path] of [
        ["GET", "/api/auth/get-session"],
        ["POST", "/api/auth/sign-in/email"],
        ["GET", "/.well-known/oauth-authorization-server"],
        ["GET", "/.well-known/oauth-protected-resource"],
        ["POST", "/api/account/claim-anon"],
      ]) {
        const res = await fetch(`${app.url}${path}`, { method });
        expect([method, path, res.status, await res.json()]).toEqual([method, path, 503, { error: "auth_disabled" }]);
      }
    } finally {
      await app.close();
    }
  });
});
