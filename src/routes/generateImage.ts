import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { generateImage, ImageGenerationTimeoutError } from "../services/imageGen.js";

const bodySchema = z.object({ prompt: z.string().min(1) });

export async function generateImageRoutes(app: FastifyInstance, config: Config) {
  app.post("/api/generate-image", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Missing or invalid 'prompt'" });
    }

    // Abort the upstream request if the client disconnects before we're
    // done, mirroring the chat route's abort-on-close behavior.
    const abortController = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
    });

    try {
      const { url } = await generateImage(config, parsed.data.prompt, abortController.signal);
      return reply.send({ url });
    } catch (err) {
      request.log.error(err);
      if (err instanceof ImageGenerationTimeoutError) {
        return reply.status(504).send({ error: err.message });
      }
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
