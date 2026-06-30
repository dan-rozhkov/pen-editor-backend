import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { generateImage } from "../services/imageGen.js";

const bodySchema = z.object({ prompt: z.string().min(1) });

export async function generateImageRoutes(app: FastifyInstance, config: Config) {
  app.post("/api/generate-image", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Missing or invalid 'prompt'" });
    }
    try {
      const { url } = await generateImage(config, parsed.data.prompt);
      return reply.send({ url });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
