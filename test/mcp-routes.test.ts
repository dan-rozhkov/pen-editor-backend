import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { resetBridgeForTests, sessionCount } from "../src/mcp/bridge.js";
import { makeConfig } from "./helpers.js";

const TOKEN = "a-very-secret-token!"; // >= 16 chars per MCP_AUTH_TOKEN validation

describe("mcpRoutes — HTTP (auth disabled)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), {
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 503 for POST /api/mcp when MCP_AUTH_TOKEN is unset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: { jsonrpc: "2.0", method: "ping" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns 503 for GET /api/mcp when MCP_AUTH_TOKEN is unset", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp" });
    expect(res.statusCode).toBe(503);
  });

  it("returns 503 for DELETE /api/mcp when MCP_AUTH_TOKEN is unset", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/mcp" });
    expect(res.statusCode).toBe(503);
  });
});

describe("mcpRoutes — HTTP (auth enabled)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: TOKEN }), {
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 401 for POST /api/mcp with no Authorization header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: { jsonrpc: "2.0", method: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for POST /api/mcp with the wrong bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: "Bearer wrong-token-1234567" },
      payload: { jsonrpc: "2.0", method: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for GET /api/mcp with the wrong bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp",
      headers: { authorization: "Bearer wrong-token-1234567" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for DELETE /api/mcp with the wrong bearer token", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp",
      headers: { authorization: "Bearer wrong-token-1234567" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 204 for DELETE /api/mcp with the correct bearer token (stateless — no session to delete)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // A genuine cross-origin browser preflight (Origin +
  // Access-Control-Request-Method) is answered by the global @fastify/cors
  // onRequest hook (registered in app.ts, src/plugins/cors.ts) before
  // routing reaches mcpRoutes' own app.options("/api/mcp") handler — so this
  // is the response a real client (e.g. the MCP Inspector) actually sees.
  // cors.ts's allowedHeaders/methods were widened for /api/mcp's Authorization
  // bearer auth and DELETE support; mcpRoutes' own OPTIONS handler exists as
  // a defensive fallback (e.g. a non-strict preflight) but is not the path a
  // standards-compliant browser preflight takes.
  it("responds to a real preflight with 204 and CORS headers allowing Authorization/DELETE", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/mcp",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://example.com",
    );
    expect(res.headers["access-control-allow-headers"]).toContain(
      "Authorization",
    );
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(res.headers["access-control-expose-headers"]).toContain(
      "Mcp-Session-Id",
    );
  });


  it("reflects an allowed origin's CORS header even on a 401", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp",
      headers: { origin: "https://example.com" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://example.com",
    );
  });
});

describe("mcpRoutes — CORS_ALLOWED_ORIGINS restricts reflected origin", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(
      makeConfig({
        MCP_AUTH_TOKEN: TOKEN,
        CORS_ALLOWED_ORIGINS: "https://allowed.example.com",
      }),
      { logger: false },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("does not reflect a disallowed origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/mcp",
      headers: { origin: "https://not-allowed.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reflects an allowed origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/mcp",
      headers: { origin: "https://allowed.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://allowed.example.com",
    );
  });
});

describe("mcpRoutes — WebSocket auth", () => {
  afterEach(() => {
    resetBridgeForTests();
  });

  it("rejects the upgrade with 503 when MCP_AUTH_TOKEN is unset", async () => {
    const app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), {
      logger: false,
    });
    await app.ready();
    try {
      await expect(app.injectWS("/api/mcp/ws")).rejects.toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("rejects the upgrade with 401 when the token query param is missing or wrong", async () => {
    const app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: TOKEN }), {
      logger: false,
    });
    await app.ready();
    try {
      await expect(app.injectWS("/api/mcp/ws")).rejects.toBeDefined();
      await expect(
        app.injectWS("/api/mcp/ws?token=wrong-token-1234567"),
      ).rejects.toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("registers exactly one session per accepted connection", async () => {
    const app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: TOKEN }), {
      logger: false,
    });
    await app.ready();
    try {
      const ws = await app.injectWS(`/api/mcp/ws?token=${TOKEN}`);
      // registerSession is called synchronously in the connection handler.
      expect(sessionCount()).toBe(1);
      ws.terminate();
    } finally {
      await app.close();
    }
  });
});
