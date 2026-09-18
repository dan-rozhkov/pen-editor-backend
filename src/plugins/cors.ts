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
    // X-OpenCode-Key: the browser-only OpenCode BYOK header (see
    // docs/specs/2026-09-18-opencode-byok-design.md, "Поток ключа") sent on
    // POST /api/chat when the picked model is an OpenCode one. This is an
    // explicit allowlist, not a wildcard — without this entry, any real
    // cross-origin browser request carrying that header dies on the CORS
    // preflight before it ever reaches the chat route handler.
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Mcp-Session-Id",
      "X-OpenCode-Key",
    ],
    exposedHeaders: ["Mcp-Session-Id"],
  });
}
