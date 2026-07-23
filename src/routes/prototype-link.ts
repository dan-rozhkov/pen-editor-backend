import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { generatePrototypeLinks } from "../ai/prototype-link.js";

const bodySchema = z.object({
  screens: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        content: z.string().optional(),
        candidates: z.array(
          z.object({
            protoId: z.string().min(1),
            tag: z.string(),
            text: z.string(),
            ariaLabel: z.string().optional(),
            href: z.string().optional(),
          }),
        ),
      }),
    )
    .min(2, "need at least two screens to link"),
});

export async function prototypeLinkRoutes(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  app.post("/api/prototype-link", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    try {
      const result = await generatePrototypeLinks(
        parsed.data.screens,
        config,
      );
      return reply.send(result);
    } catch (err) {
      app.log.error({ err }, "prototype-link failed");
      return reply
        .status(502)
        .send({ error: "failed to generate prototype links" });
    }
  });
}
