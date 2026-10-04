import type { FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer, type McpContext } from "./server.js";

// A new McpServer + transport per request: Protocol.connect() throws
// "Already connected to a transport..." if a second request overlaps
// the first on a shared server instance (e.g. a GET SSE stream held
// open alongside a POST, or two concurrent POSTs) — and since that
// throw happens after reply.hijack(), the request would just hang.
// Matches the SDK's own stateless example
// (examples/server/simpleStatelessStreamableHttp.js), which builds a
// fresh server per request and closes both server and transport on
// response close. Shared by the legacy /api/mcp and the account-scoped /mcp:
// the caller authenticates first, `ctx` says whose tabs the tools may reach.
export async function serveStreamable(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: McpContext,
  body?: unknown,
): Promise<void> {
  reply.hijack();
  const server = buildMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  reply.raw.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request.raw, reply.raw, body);
}
