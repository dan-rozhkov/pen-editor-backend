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

// Regression test for a Critical review finding: a shared, plugin-scoped
// McpServer with `.connect(transport)` called per request throws "Already
// connected to a transport..." from the SDK's Protocol.connect() the moment
// a second request overlaps the first — and since that throw happens after
// reply.hijack(), the request just hangs instead of erroring visibly. Each
// POST/GET handler must build its own McpServer per request (mirroring the
// SDK's own stateless example, examples/server/simpleStatelessStreamableHttp.js).
// Uses listen+fetch (not app.inject()) since these routes hijack the reply
// — see CLAUDE.md's chat-route testing note, same reasoning applies here.
describe("mcpRoutes — concurrent requests do not hang (per-request McpServer)", () => {
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: TOKEN }), {
      logger: false,
    });
    base = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  function initializeRequest(id: number) {
    return fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
  }

  it("two concurrent POST initialize requests both complete (neither hangs)", async () => {
    const timeout = (label: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} timed out — likely hung on a shared McpServer`)),
          5_000,
        ),
      );

    const [resA, resB] = await Promise.all([
      Promise.race([initializeRequest(1), timeout("request A")]),
      Promise.race([initializeRequest(2), timeout("request B")]),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  });

  it("a GET SSE stream held open does not block a concurrent POST", async () => {
    const timeout = (label: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} timed out — likely hung on a shared McpServer`)),
          5_000,
        ),
      );

    const getStream = fetch(`${base}/api/mcp`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
    });

    const [getRes, postRes] = await Promise.all([
      Promise.race([getStream, timeout("GET stream")]),
      Promise.race([initializeRequest(3), timeout("concurrent POST")]),
    ]);

    expect(getRes.status).toBe(200);
    expect(postRes.status).toBe(200);
    // Release the held-open SSE stream so it doesn't leak past the test.
    await getRes.body?.cancel();
  });
});
