import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { parseEnvList, type Config } from "../config.js";

export async function registerCors(app: FastifyInstance, config: Config) {
  const allowedOrigins = parseEnvList(config.CORS_ALLOWED_ORIGINS);

  await app.register(cors, {
    // Empty allowlist = reflect any origin (local development only).
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    // DELETE and the extra headers are for /api/mcp (src/mcp/routes.ts):
    // @fastify/cors answers every OPTIONS preflight itself via a global
    // onRequest hook (strictPreflight) before any route handler — including
    // mcpRoutes' own OPTIONS handler — ever runs, so this plugin-level
    // config is what a real cross-origin MCP client (e.g. the MCP
    // Inspector) actually sees on preflight.
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    // Both extra headers carry a credential the BROWSER owns and the server
    // never stores, so each must be named explicitly — this is an allowlist,
    // not a wildcard, and a missing entry kills the cross-origin preflight
    // before the request ever reaches a route handler. The deployed frontend
    // and backend are separate origins, so that is the normal path, not an
    // edge case.
    //   X-OpenCode-Key  — OpenCode BYOK key, sent to POST /api/chat when the
    //     picked model is an OpenCode one (docs/specs/2026-09-18-opencode-byok-design.md).
    //   X-Mobbin-Token  — the user's own Mobbin OAuth access token
    //     (docs/superpowers/specs/2026-09-18-mobbin-mcp-design.md).
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Mcp-Session-Id",
      "X-OpenCode-Key",
      "X-Mobbin-Token",
    ],
    exposedHeaders: ["Mcp-Session-Id"],
  });
}
