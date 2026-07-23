import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isOriginAllowed, parseEnvList, type Config } from "../config.js";
import { buildMcpServer } from "./server.js";
import { registerSession } from "./bridge.js";
import { constantTimeEqual, extractBearerToken } from "./auth.js";

export async function mcpRoutes(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(websocketPlugin);

  const allowedOrigins = parseEnvList(config.CORS_ALLOWED_ORIGINS);

  function setCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
    const origin = request.headers.origin;
    reply.raw.setHeader("Vary", "Origin");
    if (origin && isOriginAllowed(allowedOrigins, origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    }
    reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    reply.raw.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  }

  // Returns true and lets the caller proceed, or sends the error response
  // and returns false. MCP_AUTH_TOKEN unset -> 503 (feature off); missing or
  // wrong bearer token -> 401.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!config.MCP_AUTH_TOKEN) {
      reply.status(503).send({ error: "MCP is not enabled on this server (MCP_AUTH_TOKEN unset)." });
      return false;
    }
    const token = extractBearerToken(request.headers.authorization);
    if (!token || !constantTimeEqual(token, config.MCP_AUTH_TOKEN)) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  app.options("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    reply.status(204).send();
  });

  app.post("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    if (!requireAuth(request, reply)) return;

    reply.hijack();
    // A new McpServer + transport per request: Protocol.connect() throws
    // "Already connected to a transport..." if a second request overlaps
    // the first on a shared server instance (e.g. a GET SSE stream held
    // open alongside a POST, or two concurrent POSTs) — and since that
    // throw happens after reply.hijack(), the request would just hang.
    // Matches the SDK's own stateless example
    // (examples/server/simpleStatelessStreamableHttp.js), which builds a
    // fresh server per request and closes both server and transport on
    // response close.
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  app.get("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    if (!requireAuth(request, reply)) return;

    reply.hijack();
    // See the POST handler above: a fresh McpServer per request avoids
    // Protocol.connect()'s "Already connected" throw when this GET stream
    // overlaps another concurrent request.
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw);
  });

  app.delete("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    if (!requireAuth(request, reply)) return;
    // Stateless mode (sessionIdGenerator: undefined) has no server-side
    // session to delete.
    reply.status(204).send();
  });

  app.get(
    "/api/mcp/ws",
    {
      websocket: true,
      preValidation: (request, reply, done) => {
        if (!config.MCP_AUTH_TOKEN) {
          reply.status(503).send({ error: "MCP is not enabled on this server (MCP_AUTH_TOKEN unset)." });
          done(new Error("mcp disabled"));
          return;
        }
        const query = request.query as { token?: string };
        if (!query.token || !constantTimeEqual(query.token, config.MCP_AUTH_TOKEN)) {
          reply.status(401).send({ error: "Unauthorized" });
          done(new Error("unauthorized"));
          return;
        }
        done();
      },
    },
    (socket) => {
      registerSession(socket);
    },
  );
}
