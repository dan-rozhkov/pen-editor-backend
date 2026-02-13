import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export async function registerCors(app: FastifyInstance) {
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });
}
