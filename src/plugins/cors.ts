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
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
    exposedHeaders: ["Mcp-Session-Id"],
  });
}
