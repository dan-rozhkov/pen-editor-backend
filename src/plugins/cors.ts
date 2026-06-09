import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { parseEnvList, type Config } from "../config.js";

export async function registerCors(app: FastifyInstance, config: Config) {
  const allowedOrigins = parseEnvList(config.CORS_ALLOWED_ORIGINS);

  await app.register(cors, {
    // Empty allowlist = reflect any origin (local development only).
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });
}
