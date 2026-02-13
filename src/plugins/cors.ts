import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";

export async function registerCors(app: FastifyInstance, config: Config) {
  await app.register(cors, {
    origin: config.FRONTEND_URL,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });
}
