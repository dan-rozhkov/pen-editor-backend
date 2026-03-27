import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";

export async function registerMultipart(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
    },
  });
}
